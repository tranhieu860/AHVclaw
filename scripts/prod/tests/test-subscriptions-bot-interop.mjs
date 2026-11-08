#!/usr/bin/env node
// Full plugin and bot processes coordinate one rotating token in a temporary home.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const account = 'dead@claude.test'

if (process.env.SUBSCRIPTIONS_INTEROP_BOT === '1') {
  assert.ok(process.env.HOME && process.env.DSH_HOME, 'worker requires an explicit fixture home')
  const authPath = join(process.env.DSH_HOME, 'plugins/subscriptions/auth.json')
  const rename = fs.renameSync
  fs.renameSync = function (from, to, ...args) {
    try { return rename(from, to, ...args) }
    catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code) && String(to) === `${authPath}.refresh-claude.lock`) process.send({ type: 'lock-wait' })
      throw error
    }
  }
  syncBuiltinESMExports()
  const { loginRefreshReport, REFRESH_ENDPOINTS } = await import(pathToFileURL(process.env.SUBSCRIPTIONS_INTEROP_BOT_FILE).href)
  const started = new Promise(resolve => process.once('message', resolve))
  process.send({ type: 'ready' })
  await started
  let calls = 0
  try {
    const report = await loginRefreshReport({ fetchFn: async (url, init) => {
      assert.equal(url, REFRESH_ENDPOINTS.claude.url, 'unexpected endpoint in refresh-only command')
      calls++
      const released = new Promise(resolve => process.once('message', resolve))
      process.send({ type: 'token-request', spentOldToken: JSON.parse(init.body).refresh_token === 'fake-claude-prior-refresh' })
      await released
      return new Response(JSON.stringify({ access_token: 'fake-bot-access', refresh_token: 'fake-bot-refresh', expires_in: 3600 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    } })
    process.send({ type: 'done', calls, report })
  } catch (error) { process.send({ type: 'done', error: String(error) }) }
  await new Promise(() => {})
}

const plugin = resolve(process.argv[2] ?? '')
assert.ok(process.argv[2], 'usage: node test-subscriptions-bot-interop.mjs <plugin-dir> [--bot <bot-file>]')
const botIndex = process.argv.indexOf('--bot')
const bot = resolve(botIndex === -1 ? join(here, '../ahv-bot.mjs') : process.argv[botIndex + 1])
const home = mkdtempSync(join(tmpdir(), 'subs-bot-interop-'))
const dshHome = join(home, '.dsh')
const store = join(dshHome, 'plugins/subscriptions/auth.json')
process.env.HOME = home
process.env.DSH_HOME = dshHome
mkdirSync(dirname(store), { recursive: true })
writeFileSync(store, JSON.stringify({ claude: { default: account, accounts: { [account]: {
  accessToken: 'fake-claude-prior-access', refreshToken: 'fake-claude-prior-refresh',
  expiresAt: Date.now() - 1000, refreshTokenExpiresAt: 1900000000000, emailAddress: account,
} } } }), { mode: 0o600 })

function worker(file, args, extraEnv) {
  const child = fork(file, args, {
    execArgv: ['--import', join(here, 'helpers/subscriptions-register.mjs')],
    env: { PATH: process.env.PATH, HOME: home, DSH_HOME: dshHome, AHV_FORK: resolve(here, '../../..'), ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  let ended = false
  const queued = [], pending = []
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    ended = true
    for (const wait of pending.splice(0)) wait.reject(new Error(`worker exited ${code}/${signal}: ${stderr}`))
    resolve()
  }))
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('message', message => {
    const index = pending.findIndex(wait => wait.types.includes(message.type))
    if (index === -1) queued.push(message)
    else pending.splice(index, 1)[0].resolve(message)
  })
  return {
    send: message => child.send(message),
    async wait(...types) {
      const index = queued.findIndex(message => types.includes(message.type))
      if (index !== -1) return queued.splice(index, 1)[0]
      if (ended) throw new Error(`worker already exited: ${stderr}`)
      let timer
      try {
        return await Promise.race([
          new Promise((resolve, reject) => pending.push({ types, resolve, reject })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`worker timed out waiting for ${types}: ${stderr}`)), 10000) }),
        ])
      } finally { clearTimeout(timer) }
    },
    async close() { child.kill(); await exited },
  }
}

const pluginWorker = worker(join(here, 'test-subscriptions-keep-session.mjs'), ['--plugin', plugin], {
  SUBSCRIPTIONS_TEST_WORKER: '1', SUBSCRIPTIONS_TEST_HOME: home,
})
const botWorker = worker(fileURLToPath(import.meta.url), [], {
  SUBSCRIPTIONS_INTEROP_BOT: '1', SUBSCRIPTIONS_INTEROP_BOT_FILE: bot,
})
try {
  await Promise.all([pluginWorker.wait('ready'), botWorker.wait('ready')])
  pluginWorker.send({ action: 'refresh', provider: 'claude' })
  await pluginWorker.wait('token-request')
  assert.equal(statSync(`${store}.refresh-claude.lock`).mode & 0o777, 0o700)
  assert.equal(statSync(join(`${store}.refresh-claude.lock`, 'owner.json')).mode & 0o777, 0o600)
  botWorker.send({ action: 'refresh' })
  const observed = await botWorker.wait('lock-wait', 'token-request', 'done')
  pluginWorker.send({ release: 'token' })
  if (observed.type === 'token-request') botWorker.send({ release: 'token' })
  const [pluginDone, botDone] = await Promise.all([
    pluginWorker.wait('done'), observed.type === 'done' ? observed : botWorker.wait('done'),
  ])
  assert.equal(pluginDone.error, undefined)
  assert.equal(botDone.error, undefined)
  assert.equal(observed.type, 'lock-wait', 'bot spent the old refresh token while the plugin held its provider lock')
  assert.equal(botDone.calls, 0, 'bot did not reload the fresh plugin session after acquiring the shared lock')
  const session = JSON.parse(readFileSync(store, 'utf8')).claude.accounts[account]
  assert.equal(session.accessToken, 'fake-claude-at-refreshed')
  assert.equal(session.refreshToken, 'fake-claude-rt-refreshed')
  assert.equal(session.refreshTokenExpiresAt, 1900000000000)
  assert.ok(session.expiresAt > Date.now() + 3000000)
  const row = botDone.report.providers.claude.accounts[0]
  assert.equal(row.skipped, 'fresh')
  assert.equal(row.refreshed, false)
  assert.equal(row.expires_at, session.expiresAt)
  assert.equal(existsSync(`${store}.refresh-claude.lock`), false)
  assert.equal(existsSync(`${store}.lock`), false)
  console.log('PASS plugin and bot share the provider lock, reload the rotated session, and preserve metadata')
} finally {
  await Promise.all([pluginWorker.close(), botWorker.close()])
  rmSync(home, { recursive: true, force: true })
}
