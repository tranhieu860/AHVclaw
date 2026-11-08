#!/usr/bin/env node
// Abandoned auth locks recover through the actual bot and published plugin operations.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = resolve(process.env.AUTH_LOCK_PLUGIN_UNDER_TEST ?? process.argv[2] ?? '')
assert.ok(process.env.AUTH_LOCK_PLUGIN_UNDER_TEST || process.argv[2], 'usage: node test-auth-lock-recovery.mjs <patched-plugin-directory>')
const bot = resolve(process.env.AHV_BOT_UNDER_TEST ?? join(here, '../ahv-bot.mjs'))
const root = mkdtempSync(join(tmpdir(), 'auth-lock-recovery-'))
const children = new Set()
let home, store, passed = 0, failed = 0
const key = 'lock@example.test'
const session = () => ({ accessToken: 'fake-old', refreshToken: 'fake-refresh', expiresAt: Date.now() - 1000, emailAddress: key })
const write = data => writeFileSync(store, JSON.stringify(data), { mode: 0o600 })
const read = () => JSON.parse(readFileSync(store, 'utf8'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function identity(pid = process.pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  return { pid, start: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19], boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() }
}
function plant(path, owner) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  writeFileSync(join(path, 'owner.json'), JSON.stringify(owner), { mode: 0o600 })
}
// Retire planted fixture locks atomically while real contenders are polling.
function releasePlantedLock(path) {
  const retired = `${path}.fixture-released-${Math.random().toString(36).slice(2)}`
  renameSync(path, retired)
  rmSync(retired, { recursive: true })
}
function worker(engine, config = {}) {
  const child = fork(join(here, 'helpers/auth-lock-worker.mjs'), [], {
    execArgv: ['--import', join(here, 'helpers/subscriptions-register.mjs')],
    env: { PATH: process.env.PATH, HOME: home, DSH_HOME: join(home, '.dsh'), AHV_FORK: resolve(here, '../../..'), AUTH_LOCK_WORKER: JSON.stringify({ engine, bot, plugin, ...config }) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.add(child)
  const messages = [], pending = []
  let stdout = '', stderr = '', ended
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const done = new Promise(resolve => child.on('close', (code, signal) => {
    ended = { type: 'exit', code, signal, stdout, stderr }
    children.delete(child)
    for (const waiter of pending.splice(0)) waiter.resolve(ended)
    resolve(ended)
  }))
  child.on('message', message => {
    messages.push(message)
    const index = pending.findIndex(item => item.types.includes(message.type))
    if (index !== -1) { message.taken = true; pending.splice(index, 1)[0].resolve(message) }
  })
  return {
    child, done, messages,
    send(message) { if (child.connected) child.send(message) },
    async wait(types, ms = 2000) {
      const found = messages.find(message => types.includes(message.type) && !message.taken)
      if (found) { found.taken = true; return found }
      if (ended) return ended
      let timer, waiter
      try {
        return await Promise.race([
          new Promise(resolve => { waiter = { types, resolve }; pending.push(waiter) }),
          new Promise(resolve => { timer = setTimeout(() => resolve({ type: 'watchdog', stdout, stderr }), ms) }),
        ])
      } finally {
        clearTimeout(timer)
        const index = pending.indexOf(waiter)
        if (index !== -1) pending.splice(index, 1)
      }
    },
    async start() { assert.equal((await this.wait(['ready'])).type, 'ready', stderr); this.send({ action: 'run' }) },
    async close() { if (!ended) child.kill('SIGKILL'); await done },
  }
}
async function result(w, ms = 950) {
  const value = await w.wait(['done'], ms)
  assert.notEqual(value.type, 'watchdog', `operation did not recover before ${ms}ms; ${value.stderr}`)
  if (value.type === 'exit') {
    assert.equal(value.code, 0, value.stdout + value.stderr)
    return { result: JSON.parse(value.stdout), calls: w.messages.filter(message => message.type === 'endpoint').length }
  }
  assert.equal(value.error, undefined, JSON.stringify(value))
  assert.equal(value.result?.error, undefined, JSON.stringify(value.result))
  return value
}
async function check(name, fn) {
  if (process.env.AUTH_LOCK_TEST_FILTER && !name.includes(process.env.AUTH_LOCK_TEST_FILTER)) return
  home = mkdtempSync(join(root, 'case-'))
  store = join(home, '.dsh/plugins/subscriptions/auth.json')
  mkdirSync(dirname(store), { recursive: true })
  write({ claude: { default: key, accounts: { [key]: session() } }, untouched: { marker: 'keep' } })
  try { await fn(); console.log(`PASS ${name}`); passed++ }
  catch (error) { console.error(`FAIL ${name}: ${error.stack}`); failed++ }
  finally { await Promise.all([...children].map(async child => { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)) })); rmSync(home, { recursive: true, force: true }) }
}
function noDebris() {
  assert.equal(existsSync(`${store}.refresh-claude.lock`), false)
  assert.equal(existsSync(`${store}.lock`), false)
}
async function deadOwner(engine, signal) {
  const w = worker(engine, { endpoint: signal === 'exit13' ? 'exit13' : 'hold' })
  await w.start()
  assert.equal((await w.wait(['endpoint'])).type, 'endpoint', 'owner must hold a real production refresh lock')
  assert.equal(existsSync(`${store}.refresh-claude.lock`), true)
  if (signal !== 'exit13') w.child.kill(signal)
  const exited = await w.wait(['exit'], 2000)
  assert.equal(exited.type, 'exit', 'owner must exit without a lingering event-loop handle')
  if (signal === 'exit13') assert.equal(exited.code, 13, 'unsettled top-level await exits naturally with 13')
  else assert.equal(exited.signal, signal)
}

for (const engine of ['bot', 'plugin']) {
  for (const signal of ['SIGKILL', 'SIGTERM', 'exit13']) await check(`${engine}: ${signal} real owner recovery below one second`, async () => {
    await deadOwner(engine, signal)
    const w = worker(engine)
    await w.start()
    const started = performance.now()
    const value = await result(w)
    assert.ok(performance.now() - started < 1000)
    assert.equal(value.calls, 1, 'one-use refresh endpoint called exactly once')
    assert.equal(read().claude.accounts[key].accessToken, 'fake-next')
    assert.deepEqual(read().untouched, { marker: 'keep' })
    noDebris()
  })

  await check(`${engine}: live owner waits 1300ms then succeeds`, async () => {
    const owner = worker(engine, { endpoint: 'hold' })
    await owner.start(); assert.equal((await owner.wait(['endpoint'])).type, 'endpoint')
    const contender = worker(engine)
    await contender.start()
    await delay(1300)
    assert.equal(contender.messages.some(message => ['done', 'endpoint'].includes(message.type)), false, 'live owner cannot be bypassed or timed out at 200ms')
    owner.send({ release: 'endpoint' })
    assert.equal((await result(owner)).calls, 1)
    assert.equal((await result(contender)).calls, 0, 'contender rereads the refreshed token')
    noDebris()
  })

  for (const scenario of ['start', 'boot', 'dead-null', 'orphan-reclaim']) await check(`${engine}: recover ${scenario}`, async () => {
    const path = `${store}.refresh-claude.lock`
    const live = identity()
    if (scenario === 'start') plant(path, { ...live, start: `${BigInt(live.start) + 1n}` })
    if (scenario === 'boot') plant(path, { ...live, boot: 'fake-previous-boot' })
    if (scenario === 'dead-null') {
      const owner = worker(engine)
      assert.equal((await owner.wait(['ready'])).type, 'ready')
      const pid = owner.child.pid; await owner.close()
      plant(path, { pid, start: null, boot: null })
    }
    if (scenario === 'orphan-reclaim') {
      await deadOwner(engine, 'SIGKILL')
      const reaper = worker(engine, { pauseReclaim: `${path}.reclaim` })
      await reaper.start()
      assert.equal((await reaper.wait(['under-reclaim'], 1000)).type, 'under-reclaim', 'a real reclaimer must publish its own lock before it dies')
      reaper.child.kill('SIGKILL')
      assert.equal((await reaper.wait(['exit'])).signal, 'SIGKILL')
    }
    const w = worker(engine, { noProc: scenario === 'dead-null' })
    await w.start(); assert.equal((await result(w)).calls, 1)
    assert.equal(existsSync(`${path}.reclaim`), false)
    noDebris()
  })

  for (const scenario of ['EPERM', 'no-proc-live']) await check(`${engine}: ${scenario} owner stays alive`, async () => {
    const owner = { ...identity(), start: null, boot: null }
    const path = `${store}.refresh-claude.lock`
    plant(path, owner)
    const w = worker(engine, { epermPid: scenario === 'EPERM' ? process.pid : undefined, noProc: true })
    await w.start(); await delay(1300)
    assert.equal(w.messages.some(message => ['done', 'endpoint'].includes(message.type)), false, `${scenario} must not authorize reclaim`)
    assert.deepEqual(JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')), owner)
    releasePlantedLock(path)
    assert.equal((await result(w)).calls, 1)
    noDebris()
  })

  await check(`${engine}: atomic owner publication`, async () => {
    const w = worker(engine)
    await w.start(); await result(w)
    const publications = w.messages.filter(message => message.type === 'publication' && message.path.endsWith('.lock'))
    assert.ok(publications.length >= 2, 'provider and store locks publish owner before rename')
    assert.equal(w.messages.some(message => message.type === 'invalid-publication'), false)
    for (const publication of publications) {
      assert.equal(publication.owner.pid, w.child.pid)
      assert.equal(typeof publication.owner.start, 'string')
      assert.equal(publication.owner.boot, identity().boot)
      assert.equal(publication.mode, 0o700)
      assert.equal(publication.ownerMode, 0o600)
    }
  })

  await check(`${engine}: proc stat start survives closing parentheses in comm`, async () => {
    const w = worker(engine, { procComm: true, endpoint: 'hold' })
    await w.start(); assert.equal((await w.wait(['endpoint'])).type, 'endpoint')
    const owner = JSON.parse(readFileSync(join(`${store}.refresh-claude.lock`, 'owner.json'), 'utf8'))
    assert.equal(owner.start, identity(w.child.pid).start, 'field 22 begins after the last closing parenthesis')
    w.send({ release: 'endpoint' }); await result(w)
  })

  await check(`${engine}: rechecks changed owner under reclaim`, async () => {
    const path = `${store}.refresh-claude.lock`
    plant(path, { ...identity(), start: '0' })
    const w = worker(engine, { pauseReclaim: `${path}.reclaim` })
    await w.start()
    assert.equal((await w.wait(['under-reclaim', 'done', 'endpoint'], 1000)).type, 'under-reclaim', 'must acquire reclaim before retiring observed lock')
    const replacement = identity()
    writeFileSync(join(path, 'owner.json'), JSON.stringify(replacement))
    writeFileSync(join(home, 'release-reclaim'), '')
    w.send({ release: 'reclaim' })
    await delay(200)
    assert.equal(w.messages.some(message => ['done', 'endpoint'].includes(message.type)), false, 'changed live owner must survive the stale observation')
    assert.deepEqual(JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')), replacement)
    releasePlantedLock(path)
    assert.equal((await result(w)).calls, 1)
    noDebris()
  })

  await check(`${engine}: rechecks owner liveness under reclaim without proc metadata`, async () => {
    const path = `${store}.refresh-claude.lock`
    const owner = { pid: process.pid, start: null, boot: null }
    plant(path, owner)
    const w = worker(engine, { noProc: true, esrchOncePid: process.pid, pauseReclaim: `${path}.reclaim` })
    await w.start()
    assert.equal((await w.wait(['under-reclaim', 'done', 'endpoint'], 1000)).type, 'under-reclaim')
    writeFileSync(join(home, 'release-reclaim'), '')
    w.send({ release: 'reclaim' })
    await delay(200)
    assert.equal(w.messages.some(message => ['done', 'endpoint'].includes(message.type)), false, 'same owner bytes now describe a live pid, so the death check must run again')
    assert.deepEqual(JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')), owner)
    releasePlantedLock(path)
    assert.equal((await result(w)).calls, 1)
    noDebris()
  })

  await check(`${engine}: changed dead owner requires a new reclaim observation`, async () => {
    const path = `${store}.refresh-claude.lock`
    plant(path, { ...identity(), start: '0' })
    const w = worker(engine, { pauseReclaim: `${path}.reclaim`, pauseReclaimEvery: true })
    await w.start()
    assert.equal((await w.wait(['under-reclaim', 'done', 'endpoint'], 1000)).round, 1)
    const replacement = { ...identity(), start: '1' }
    writeFileSync(join(path, 'owner.json'), JSON.stringify(replacement))
    writeFileSync(join(home, 'release-reclaim-1'), '')
    w.send({ release: 'reclaim-1' })
    const next = await w.wait(['under-reclaim', 'done', 'endpoint'], 1000)
    assert.equal(next.type, 'under-reclaim', 'changed bytes must be observed again before reclaiming the replacement')
    assert.equal(next.round, 2)
    assert.deepEqual(JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')), replacement)
    releasePlantedLock(path)
    writeFileSync(join(home, 'release-reclaim-2'), '')
    w.send({ release: 'reclaim-2' })
    assert.equal((await result(w)).calls, 1)
    noDebris()
  })
}

for (const [ownerEngine, nextEngine] of [['bot', 'plugin'], ['plugin', 'bot']]) await check(`${ownerEngine} abandoned lock is recovered by ${nextEngine}`, async () => {
  await deadOwner(ownerEngine, 'SIGKILL')
  const w = worker(nextEngine)
  await w.start(); assert.equal((await result(w)).calls, 1)
  noDebris()
})

await check('two mixed contenders retire a dead lock with one endpoint and no lost update', async () => {
  await deadOwner('bot', 'SIGKILL')
  const a = worker('bot', { endpoint: 'hold' }), b = worker('plugin', { endpoint: 'hold' })
  await Promise.all([a.start(), b.start()])
  const winner = await Promise.race([a.wait(['endpoint'], 950).then(message => ({ w: a, message })), b.wait(['endpoint'], 950).then(message => ({ w: b, message }))])
  assert.equal(winner.message.type, 'endpoint', 'a contender recovers without waiting for the abandoned owner')
  await delay(150)
  assert.equal([...a.messages, ...b.messages].filter(message => message.type === 'endpoint').length, 1, 'one critical section is active')
  winner.w.send({ release: 'endpoint' })
  const values = await Promise.all([result(a), result(b)])
  assert.equal(values.reduce((sum, value) => sum + value.calls, 0), 1)
  assert.deepEqual(read().untouched, { marker: 'keep' })
  assert.equal(read().claude.accounts[key].refreshToken, 'fake-next-refresh')
  noDebris()
})

await check('two store contenders serialize recovery and preserve both updates', async () => {
  const lock = `${store}.lock`
  const owner = worker('plugin', { action: 'logout', holdPublished: lock })
  await owner.start(); assert.equal((await owner.wait(['store-held'])).type, 'store-held')
  owner.child.kill('SIGKILL'); assert.equal((await owner.wait(['exit'])).signal, 'SIGKILL')
  mkdirSync(join(home, '.grok'), { recursive: true })
  writeFileSync(join(home, '.grok/auth.json'), JSON.stringify({ access_token: 'fake-grok', refresh_token: 'fake-grok-refresh', expires_at: Date.now() + 3_600_000 }))
  const a = worker('bot', { action: 'import', holdPublished: lock }), b = worker('plugin', { action: 'logout', holdPublished: lock })
  await Promise.all([a.start(), b.start()])
  const first = await Promise.race([a.wait(['store-held'], 950), b.wait(['store-held'], 950)])
  assert.equal(first.type, 'store-held')
  await delay(150)
  assert.equal([...a.messages, ...b.messages].filter(message => message.type === 'store-held').length, 1, 'only one writer enters the recovered critical section')
  writeFileSync(join(home, 'release-store'), '')
  a.send({ release: 'store' }); b.send({ release: 'store' })
  const [imported] = await Promise.all([result(a), result(b)])
  assert.equal(imported.result.grok.imported, true)
  assert.equal(read().claude, undefined)
  const grok = read().grok
  assert.ok((grok.accounts ? Object.values(grok.accounts) : [grok]).some(value => value.accessToken === 'fake-grok'))
  assert.deepEqual(read().untouched, { marker: 'keep' })
  noDebris()
})

for (const action of ['import', 'logout']) for (const signal of ['SIGKILL', 'SIGTERM', 'exit13']) await check(`bot ${action} recovers real abandoned store lock after ${signal}`, async () => {
  const owner = worker('plugin', { action: 'logout', holdPublished: `${store}.lock`, storeExit13: signal === 'exit13' })
  await owner.start()
  assert.equal((await owner.wait(['store-held'])).type, 'store-held', 'plugin logout must hold the production write lock')
  if (signal !== 'exit13') owner.child.kill(signal)
  const exited = await owner.wait(['exit'], 2000)
  assert.equal(exited.type, 'exit', 'store owner must exit without a lingering event-loop handle')
  if (signal === 'exit13') assert.equal(exited.code, 13, 'plugin store operation exits with unsettled top-level await')
  if (action === 'import') {
    mkdirSync(join(home, '.grok'), { recursive: true })
    writeFileSync(join(home, '.grok/auth.json'), JSON.stringify({ access_token: 'fake-grok', refresh_token: 'fake-grok-refresh', expires_at: Date.now() + 3_600_000 }))
  }
  const w = worker('bot', { action })
  await w.start(); const value = await result(w)
  if (action === 'import') assert.equal(value.result.grok.imported, true)
  else assert.equal(read().claude, undefined)
  noDebris()
})

await check('bot CLI busy timeout names lock path and pid without misreporting unreadable auth', async () => {
  const path = `${store}.refresh-claude.lock`
  plant(path, identity())
  const w = worker('bot', { action: 'cliRefresh', fastDeadline: true })
  await w.start()
  const value = await w.wait(['done'], 1500)
  assert.equal(value.type, 'exit', JSON.stringify(value))
  assert.equal(value.code, 1, value.stdout + value.stderr)
  const report = JSON.parse(value.stdout)
  assert.ok(report.message.includes(path), report.message)
  assert.ok(report.message.includes(String(process.pid)), report.message)
  assert.equal(/không đọc được/.test(report.message), false, report.message)
})

rmSync(root, { recursive: true, force: true })
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
