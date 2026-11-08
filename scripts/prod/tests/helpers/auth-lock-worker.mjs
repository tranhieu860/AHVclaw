// Real auth operations; only external endpoints and process/filesystem observations vary.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const config = JSON.parse(process.env.AUTH_LOCK_WORKER)
const store = join(process.env.DSH_HOME, 'plugins/subscriptions/auth.json')
const held = new Map()
let activeStore = false
const send = message => process.send?.(message)
const gates = new Map()
process.on('message', message => gates.get(message.release)?.())
const pause = key => new Promise(resolve => gates.set(key, resolve))
const syncPause = key => {
  const file = join(process.env.HOME, `release-${key}`)
  while (!fs.existsSync(file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
}
const pathOf = value => value instanceof URL ? value.pathname : String(value)
const originalRead = fs.readFileSync.bind(fs)
const unavailable = path => config.noProc && (path.startsWith('/proc/') && (path.endsWith('/stat') || path.endsWith('/boot_id')))
fs.readFileSync = (file, ...args) => {
  const path = pathOf(file)
  if (unavailable(path)) throw Object.assign(new Error('fixture has no proc metadata'), { code: 'ENOENT' })
  const value = originalRead(file, ...args)
  return config.procComm && path.endsWith('/stat') && typeof value === 'string' ? value.replace(/\([^]*\)/, '(fixture name ) with closing)') : value
}
const read = fsp.readFile.bind(fsp)
fsp.readFile = async (file, ...args) => {
  if (unavailable(pathOf(file))) throw Object.assign(new Error('fixture has no proc metadata'), { code: 'ENOENT' })
  if (config.storeExit13 && activeStore && pathOf(file) === store) {
    send({ type: 'store-held' })
    process.disconnect()
    await new Promise(() => {})
  }
  const value = await read(file, ...args)
  return config.procComm && pathOf(file).endsWith('/stat') && typeof value === 'string' ? value.replace(/\([^]*\)/, '(fixture name ) with closing)') : value
}
if (config.epermPid || config.esrchOncePid) {
  const kill = process.kill.bind(process)
  let esrchSent = false
  process.kill = (pid, signal) => {
    if (pid === config.epermPid && signal === 0) throw Object.assign(new Error('fixture EPERM'), { code: 'EPERM' })
    if (pid === config.esrchOncePid && signal === 0 && !esrchSent) { esrchSent = true; throw Object.assign(new Error('fixture ESRCH once'), { code: 'ESRCH' }) }
    return kill(pid, signal)
  }
}
if (config.fastDeadline) {
  const now = Date.now.bind(Date)
  const origin = now()
  Date.now = () => origin + (now() - origin) * 100
}

function acquired(path) {
  if (!path.endsWith('.reclaim') || config.pauseReclaim !== path || held.has(path) && !config.pauseReclaimEvery) return false
  const round = (held.get(path) ?? 0) + 1
  held.set(path, round)
  send({ type: 'under-reclaim', path, round })
  return config.pauseReclaimEvery ? `reclaim-${round}` : 'reclaim'
}
function publishing(from, to) {
  if (!/\.lock(?:\.reclaim)?$/.test(to)) return false
  const ownerPath = join(from, 'owner.json')
  let owner
  try { owner = JSON.parse(originalRead(ownerPath, 'utf8')) } catch (error) { send({ type: 'invalid-publication', path: to, error: String(error) }); return false }
  send({ type: 'publication', path: to, owner, mode: fs.statSync(from).mode & 0o777, ownerMode: fs.statSync(ownerPath).mode & 0o777 })
  return true
}
const mkdirSync = fs.mkdirSync.bind(fs)
fs.mkdirSync = (file, ...args) => {
  const result = mkdirSync(file, ...args)
  const path = pathOf(file)
  const gate = acquired(path)
  if (gate) syncPause(gate)
  return result
}
const mkdir = fsp.mkdir.bind(fsp)
fsp.mkdir = async (file, ...args) => {
  const result = await mkdir(file, ...args)
  const gate = acquired(pathOf(file))
  if (gate) await pause(gate)
  return result
}
const renameSync = fs.renameSync.bind(fs)
fs.renameSync = (from, to) => {
  publishing(pathOf(from), pathOf(to))
  const result = renameSync(from, to)
  const gate = acquired(pathOf(to))
  if (gate) syncPause(gate)
  if (config.holdPublished === pathOf(to)) { activeStore = true; if (!config.storeExit13) { send({ type: 'store-held' }); syncPause('store') } }
  return result
}
const rename = fsp.rename.bind(fsp)
fsp.rename = async (from, to) => {
  publishing(pathOf(from), pathOf(to))
  const result = await rename(from, to)
  const gate = acquired(pathOf(to))
  if (gate) await pause(gate)
  if (config.holdPublished === pathOf(to)) { activeStore = true; if (!config.storeExit13) { send({ type: 'store-held' }); await pause('store') } }
  return result
}
// The pre-recovery implementation publishes mkdir first; still hold its real store lock.
const writeSync = fs.writeFileSync.bind(fs)
fs.writeFileSync = (file, ...args) => {
  const result = writeSync(file, ...args)
  if (config.holdPublished && pathOf(file) === join(config.holdPublished, 'owner.json')) { activeStore = true; if (!config.storeExit13) { send({ type: 'store-held' }); syncPause('store') } }
  return result
}
const writeAsync = fsp.writeFile.bind(fsp)
fsp.writeFile = async (file, ...args) => {
  const result = await writeAsync(file, ...args)
  if (config.holdPublished && pathOf(file) === join(config.holdPublished, 'owner.json')) { activeStore = true; if (!config.storeExit13) { send({ type: 'store-held' }); await pause('store') } }
  return result
}
syncBuiltinESMExports()

let calls = 0
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url === 'https://claude.ai/v1/oauth/token') {
    if (JSON.parse(init.body).refresh_token !== 'fake-refresh') throw new Error('unexpected one-use token')
    calls++
    send({ type: 'endpoint', calls })
    if (config.endpoint === 'exit13') {
      process.disconnect()
      await new Promise(() => {})
    }
    if (config.endpoint === 'hold') await pause('endpoint')
    return new Response(JSON.stringify({ access_token: 'fake-next', refresh_token: 'fake-next-refresh', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url === 'https://api.anthropic.com/api/oauth/usage') return new Response(JSON.stringify({ five_hour: { utilization: 0 } }), { status: 200 })
  throw new Error(`unstubbed endpoint forbidden: ${url}`)
}

let run
if (config.engine === 'bot') {
  if (config.action === 'logout' || config.action === 'cliRefresh') run = async () => {
    process.argv = [process.execPath, config.bot, 'login', config.action === 'logout' ? 'logout' : 'refresh', ...(config.action === 'logout' ? ['claude'] : []), '--json']
    await import(pathToFileURL(config.bot).href)
    await new Promise(() => {})
  }
  else {
    const bot = await import(pathToFileURL(config.bot).href)
    run = async () => config.action === 'import' ? bot.importCliCredentials({ fetchFn: globalThis.fetch }) : bot.loginRefreshReport({ fetchFn: globalThis.fetch })
  }
} else {
  const routes = new Map()
  const handle = () => Object.assign(() => {}, { replace() {}, dispose() {} })
  const ctx = {
    effect(fn, label) {
      if (label === 'dsh-plugin-subscriptions: hourly model catalog refresh') return
      const dispose = fn()
      if (label === 'dsh-plugin-subscriptions: claude background sync timer') dispose?.()
    },
    get() {}, logger: { warn() {}, info() {}, debug() {}, error() {} },
    llm: { registerAdapter: () => handle(), listProviders: async () => [], listModels: async () => [], resolveModelInfo: async () => undefined },
    inject(deps, cb) { if (deps.includes('connection')) cb({ effect: fn => fn(), get: () => ({ fetch: { register: route => { routes.set(route.path, route); return () => {} } } }) }) },
  }
  const plugin = await import(pathToFileURL(join(config.plugin, 'lib/index.js')).href)
  plugin.apply(ctx, { pool: { enabled: false }, models: Object.fromEntries(['claude', 'codex', 'grok', 'antigravity', 'copilot'].map(provider => [provider, [{ id: 'offline', name: 'Offline' }]])) })
  run = async () => {
    const method = config.action === 'logout' ? 'logout' : 'usage'
    const route = routes.get(`/api/subscriptions-auth.${method}`)
    const response = await route.fetch(new Request(`http://localhost/api/subscriptions-auth.${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: `subscriptions-auth.${method}`, payload: { provider: 'claude', account: 'lock@example.test', force: true } }) }))
    return response.json()
  }
}
send({ type: 'ready' })
await new Promise(resolve => process.once('message', message => { if (message.action === 'run') resolve() }))
try {
  const result = await run()
  send({ type: 'done', result, calls })
} catch (error) {
  send({ type: 'done', error: String(error), calls })
}
process.disconnect?.()
