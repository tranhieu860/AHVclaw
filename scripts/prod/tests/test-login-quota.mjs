// Targeted quota reads share login usage's cache and never refresh tokens.
// Every provider request uses a fake response and an isolated DSH_HOME.
// Usage: node scripts/prod/tests/test-login-quota.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const WORKSPACE = fileURLToPath(new URL('../../../..', import.meta.url))
const home = mkdtempSync(join(WORKSPACE, '.login-quota-test-'))
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh')
process.env.AHV_FORK = REPO

const BIN = fileURLToPath(new URL('../ahv-bot.mjs', import.meta.url))
const STORE_DIR = join(process.env.DSH_HOME, 'plugins/subscriptions')
const STORE = join(STORE_DIR, 'auth.json')
const BOOK = join(STORE_DIR, 'refresh-state.json')
const CACHE = join(STORE_DIR, 'usage-cache.json')
const REQUESTS = join(home, 'requests.jsonl')
mkdirSync(STORE_DIR, { recursive: true })
const { loginQuotaReport, loginUsageReport } = await import(BIN)

const T0 = Date.UTC(2026, 9, 1, 10)
const MIN = 60_000
const HOUR = 60 * MIN
const CLAUDE_USAGE = 'https://api.anthropic.com/api/oauth/usage'
let passed = 0, failed = 0

async function acheck(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e?.message ?? e).split('\n')[0]}`); failed++ }
}

const account = (key, expiresAt = T0 + 48 * HOUR) => ({
  emailAddress: key, accessToken: `fake-at-${key}`, refreshToken: `fake-rt-${key}`, expiresAt,
})
const claudeStore = (accounts, def = Object.keys(accounts)[0]) => ({ claude: { default: def, accounts } })
const oneAccount = () => claudeStore({ 'a@x': account('a@x') })
const row = (report, key = 'a@x') => report.providers.claude.accounts.find(r => r.key === key)

function reset(store) {
  for (const f of [STORE, BOOK, CACHE, REQUESTS]) rmSync(f, { force: true })
  writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 })
}

function snapshot(file) {
  if (!existsSync(file)) return undefined
  const stat = statSync(file, { bigint: true })
  return { text: readFileSync(file, 'utf8'), inode: stat.ino, modified: stat.mtimeNs, changed: stat.ctimeNs }
}

async function quota(opts) {
  const authBefore = snapshot(STORE), bookBefore = snapshot(BOOK)
  try {
    return await loginQuotaReport({ kind: 'claude', now: T0, randomFn: () => 0, ...opts })
  } finally {
    assert.deepEqual(snapshot(STORE), authBefore, 'quota wrote auth.json')
    assert.deepEqual(snapshot(BOOK), bookBefore, 'quota wrote refresh-state.json')
  }
}

const usagePct = (pct) => ({ limits: [{ kind: 'session', percent: pct, resets_at: new Date(T0 + 5 * HOUR).toISOString() }] })
const response = (body, status = 200, retryAfter) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter ?? null : null },
  json: async () => body, text: async () => JSON.stringify(body),
})

function stubNet(answer = () => response(usagePct(37))) {
  const calls = []
  const fetchFn = async (url, init) => {
    const headers = new Headers(init?.headers)
    const call = { url: String(url), token: headers.get('authorization')?.replace(/^Bearer /, '') }
    calls.push(call)
    assert.equal(call.url, CLAUDE_USAGE, `quota sent a request to ${call.url}`)
    return typeof answer === 'function' ? answer(call) : answer
  }
  return { calls, fetchFn }
}

await acheck('quota asks exactly the selected nondefault account without refreshing a near-expiry token', async () => {
  reset({
    ...claudeStore({ 'a@x': account('a@x'), 'b@x': account('b@x', T0 + 1) }, 'a@x'),
    codex: { default: 'c1', accounts: { c1: { accessToken: 'fake-at-c1', refreshToken: 'fake-rt-c1', expiresAt: T0 + 1, accountId: 'c1' } } },
  })
  assert.equal(typeof loginQuotaReport, 'function', 'loginQuotaReport must be exported')
  const net = stubNet()
  const report = await quota({ account: 'b@x', fetchFn: net.fetchFn })
  assert.deepEqual(net.calls, [{ url: CLAUDE_USAGE, token: 'fake-at-b@x' }])
  assert.equal(report.checked_at, new Date(T0).toISOString())
  assert.deepEqual(Object.keys(report.providers), ['claude'])
  assert.equal(report.providers.claude.accounts.length, 1)
  const b = row(report, 'b@x')
  assert.equal(b.account, 'b@x')
  assert.equal(b.is_default, false)
  assert.equal(b.logged_in, true)
  assert.equal(b.supported, true)
  assert.equal(b.windows[0].used_percent, 37)
  assert.equal(b.read_at, new Date(T0).toISOString())
  assert.equal(b.refreshed, undefined)
  assert.equal(b.refresh_error, undefined)
  assert.equal(report.providers.claude.logged_in, true)
  assert.equal(report.providers.claude.supported, true)
  assert.equal(report.providers.claude.windows[0].used_percent, 37)
  assert.equal(report.providers.claude.error, undefined)
  assert.equal(existsSync(BOOK), false)
  assert.ok(existsSync(CACHE), 'successful quota reading was not cached')
  assert.doesNotMatch(JSON.stringify(report), /fake-at|fake-rt/)
})

await acheck('quota without --account asks every account of only the named kind', async () => {
  reset({
    ...claudeStore({ 'a@x': account('a@x'), 'b@x': account('b@x') }),
    codex: { accessToken: 'fake-at-c1', refreshToken: 'fake-rt-c1', expiresAt: T0 + 48 * HOUR, accountId: 'c1' },
  })
  writeFileSync(BOOK, '{"claude":{"a@x":{"retry_at":9999999999999,"failure":"invalid_grant"}}}\n', { mode: 0o600 })
  const net = stubNet()
  const report = await quota({ fetchFn: net.fetchFn })
  assert.deepEqual(net.calls.map(c => c.token).sort(), ['fake-at-a@x', 'fake-at-b@x'])
  assert.deepEqual(Object.keys(report.providers), ['claude'])
  assert.deepEqual(report.providers.claude.accounts.map(r => r.key).sort(), ['a@x', 'b@x'])
  assert.equal(row(report).is_default, true)
})

await acheck('quota provider summary prefers the default account when it is selected after another account', async () => {
  reset(claudeStore({ 'a@x': account('a@x'), 'b@x': account('b@x') }, 'b@x'))
  const net = stubNet(call => response(usagePct(call.token === 'fake-at-a@x' ? 11 : 63)))
  const report = await quota({ fetchFn: net.fetchFn })
  assert.equal(report.providers.claude.logged_in, true)
  assert.equal(report.providers.claude.supported, true)
  assert.equal(report.providers.claude.windows[0].used_percent, 63)
  assert.equal(report.providers.claude.error, undefined)
  assert.equal(row(report, 'a@x').windows[0].used_percent, 11)
  assert.equal(row(report, 'b@x').is_default, true)
})

await acheck('quota provider summary prefers the default account when it sits between other accounts', async () => {
  reset(claudeStore({ 'a@x': account('a@x'), 'b@x': account('b@x'), 'c@x': account('c@x') }, 'b@x'))
  const pct = { 'fake-at-a@x': 11, 'fake-at-b@x': 63, 'fake-at-c@x': 29 }
  const net = stubNet(call => response(usagePct(pct[call.token])))
  const report = await quota({ fetchFn: net.fetchFn })
  assert.equal(net.calls.length, 3)
  assert.equal(report.providers.claude.windows[0].used_percent, 63)
  assert.equal(row(report, 'b@x').is_default, true)
})

await acheck('quota provider summary reports the selected nondefault expired token without a request', async () => {
  reset(claudeStore({ 'a@x': account('a@x'), 'b@x': account('b@x', T0) }, 'a@x'))
  const net = stubNet()
  const report = await quota({ account: 'b@x', fetchFn: net.fetchFn })
  assert.deepEqual(net.calls, [])
  assert.equal(report.providers.claude.logged_in, true)
  assert.equal(report.providers.claude.supported, false)
  assert.deepEqual(report.providers.claude.windows, [])
  assert.match(report.providers.claude.error, /access token.*hết hạn/)
  assert.equal(row(report, 'b@x').is_default, false)
  assert.match(row(report, 'b@x').error, /access token.*hết hạn/)
})

await acheck('quota provider summary retains the selected nondefault held 429 reading and error', async () => {
  reset(claudeStore({ 'a@x': account('a@x'), 'b@x': account('b@x') }, 'a@x'))
  let answer = response(usagePct(37))
  const net = stubNet(() => answer)
  await quota({ account: 'b@x', fetchFn: net.fetchFn })
  answer = response({ error: 'rate limited' }, 429, '7200')
  await quota({ account: 'b@x', fetchFn: net.fetchFn, now: T0 + MIN })
  const report = await quota({ account: 'b@x', fetchFn: net.fetchFn, now: T0 + 2 * MIN, maxAgeSec: 0 })
  assert.equal(net.calls.length, 2)
  assert.equal(report.providers.claude.logged_in, true)
  assert.equal(report.providers.claude.supported, true)
  assert.equal(report.providers.claude.windows[0].used_percent, 37)
  assert.match(report.providers.claude.error, /^HTTP 429/)
  assert.equal(row(report, 'b@x').throttled, true)
  assert.equal(row(report, 'b@x').retry_at, new Date(T0 + MIN + 2 * HOUR).toISOString())
})

for (const [name, expiry] of [['before now', T0 - 1], ['equal to now', T0], ['zero', 0]]) {
  await acheck(`quota rejects an access token whose expiresAt is ${name} without fetching or refreshing`, async () => {
    reset(claudeStore({ 'a@x': account('a@x', expiry) }))
    const net = stubNet()
    const report = await quota({ account: 'a@x', fetchFn: net.fetchFn })
    assert.equal(net.calls.length, 0)
    assert.match(row(report).error, /expir|hết/i)
    assert.deepEqual(row(report).windows, [])
    assert.equal(existsSync(BOOK), false)
  })
}

await acheck('quota can use a fresh reading written by login usage', async () => {
  reset(oneAccount())
  const net = stubNet()
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0, randomFn: () => 0 })
  const report = await quota({ account: 'a@x', fetchFn: net.fetchFn, now: T0 + MIN, maxAgeSec: 300 })
  assert.equal(net.calls.length, 1)
  assert.equal(row(report).cached, true)
  assert.equal(row(report).read_at, new Date(T0).toISOString())
  assert.equal(row(report).windows[0].used_percent, 37)
})

await acheck('login usage can use a fresh reading written by quota', async () => {
  reset(oneAccount())
  const net = stubNet()
  await quota({ account: 'a@x', fetchFn: net.fetchFn })
  const report = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + MIN, maxAgeSec: 300, randomFn: () => 0 })
  assert.equal(net.calls.length, 1)
  assert.equal(row(report).cached, true)
  assert.equal(row(report).read_at, new Date(T0).toISOString())
  assert.equal(row(report).windows[0].used_percent, 37)
})

await acheck('quota --max-age 0 forces a new reading even at the same clock time', async () => {
  reset(oneAccount())
  let percent = 37
  const net = stubNet(() => response(usagePct(percent)))
  await quota({ account: 'a@x', fetchFn: net.fetchFn })
  percent = 61
  const report = await quota({ account: 'a@x', fetchFn: net.fetchFn, maxAgeSec: 0 })
  assert.equal(net.calls.length, 2)
  assert.equal(row(report).windows[0].used_percent, 61)
  assert.equal(row(report).cached, undefined)
})

await acheck('quota without --max-age asks again after a previous reading', async () => {
  reset(oneAccount())
  const net = stubNet()
  await quota({ account: 'a@x', fetchFn: net.fetchFn })
  await quota({ account: 'a@x', fetchFn: net.fetchFn, now: T0 + 1 })
  assert.equal(net.calls.length, 2)
})

for (const first of ['usage', 'quota']) {
  await acheck(`a 429 seen by ${first} holds the other command even with --max-age 0`, async () => {
    reset(oneAccount())
    let answer = response(usagePct(37))
    const net = stubNet(() => answer)
    await quota({ account: 'a@x', fetchFn: net.fetchFn })
    answer = response({ error: 'rate limited' }, 429, '7200')
    const readUsage = now => loginUsageReport({ fetchFn: net.fetchFn, now, maxAgeSec: 0, randomFn: () => 0 })
    const readQuota = now => quota({ account: 'a@x', fetchFn: net.fetchFn, now, maxAgeSec: 0 })
    const throttled = await (first === 'usage' ? readUsage : readQuota)(T0 + MIN)
    const held = await (first === 'usage' ? readQuota : readUsage)(T0 + 2 * MIN)
    assert.equal(net.calls.length, 2, 'a held account was asked again')
    assert.equal(row(held).throttled, true)
    assert.match(row(held).error, /^HTTP 429/)
    assert.equal(row(held).retry_at, row(throttled).retry_at)
    assert.equal(row(held).read_at, new Date(T0).toISOString())
    assert.equal(row(held).windows[0].used_percent, 37)
  })
}

const PRELOAD = join(home, 'fake-fetch.mjs')
writeFileSync(PRELOAD, `
import { appendFileSync } from 'node:fs'
globalThis.fetch = async (url, init) => {
  const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '')
  appendFileSync(process.env.AHV_QUOTA_TEST_REQUESTS, JSON.stringify({url:String(url), token}) + '\\n')
  if (String(url) !== ${JSON.stringify(CLAUDE_USAGE)}) throw new Error('unexpected provider or refresh request')
  return new Response(JSON.stringify({limits:[{kind:'session',percent:37,resets_at:new Date(Date.now()+3600000).toISOString()}]}), {status:200,headers:{'content-type':'application/json'}})
}
`)

function cli(args) {
  const authBefore = snapshot(STORE), bookBefore = snapshot(BOOK)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/.test(key)))
  const out = spawnSync(process.execPath, ['--import', PRELOAD, BIN, 'login', 'quota', '--json', ...args], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...env, HOME: home, DSH_HOME: process.env.DSH_HOME, AHV_FORK: REPO, AHV_QUOTA_TEST_REQUESTS: REQUESTS },
  })
  assert.equal(out.error, undefined, out.error?.message)
  assert.equal(out.signal, null, 'CLI process was terminated')
  assert.deepEqual(snapshot(STORE), authBefore, 'CLI quota wrote auth.json')
  assert.deepEqual(snapshot(BOOK), bookBefore, 'CLI quota wrote refresh-state.json')
  return out
}
const requests = () => existsSync(REQUESTS) ? readFileSync(REQUESTS, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []

await acheck('CLI quota emits the same report fields and asks only the selected account', async () => {
  reset(claudeStore({ 'a@x': account('a@x', Date.now() + HOUR), 'b@x': account('b@x', Date.now() + MIN) }))
  const out = cli(['--kind', 'claude', '--account', 'b@x', '--max-age', '0'])
  assert.equal(out.status, 0, out.stderr)
  const report = JSON.parse(out.stdout)
  assert.ok(Number.isFinite(Date.parse(report.checked_at)))
  assert.deepEqual(Object.keys(report.providers), ['claude'])
  assert.equal(report.providers.claude.accounts.length, 1)
  assert.equal(row(report, 'b@x').is_default, false)
  assert.equal(row(report, 'b@x').windows[0].used_percent, 37)
  assert.ok(Number.isFinite(Date.parse(row(report, 'b@x').read_at)))
  assert.equal(report.providers.claude.logged_in, true)
  assert.equal(report.providers.claude.supported, true)
  assert.equal(report.providers.claude.windows[0].used_percent, 37)
  assert.equal(report.providers.claude.error, undefined)
  assert.deepEqual(requests(), [{ url: CLAUDE_USAGE, token: 'fake-at-b@x' }])
  assert.doesNotMatch(out.stdout, /fake-at|fake-rt/)
})

await acheck('CLI quota provider summary reports the selected nondefault expired account', async () => {
  reset(claudeStore({ 'a@x': account('a@x', Date.now() + HOUR), 'b@x': account('b@x', 0) }, 'a@x'))
  const out = cli(['--kind', 'claude', '--account', 'b@x'])
  assert.equal(out.status, 0, out.stderr)
  const report = JSON.parse(out.stdout)
  assert.equal(report.providers.claude.logged_in, true)
  assert.equal(report.providers.claude.supported, false)
  assert.deepEqual(report.providers.claude.windows, [])
  assert.match(report.providers.claude.error, /access token.*hết hạn/)
  assert.equal(report.providers.claude.accounts.length, 1)
  assert.equal(row(report, 'b@x').is_default, false)
  assert.match(row(report, 'b@x').error, /access token.*hết hạn/)
  assert.deepEqual(requests(), [])
})

await acheck('CLI quota provider summary reports the selected nondefault held 429 account', async () => {
  reset(claudeStore({ 'a@x': account('a@x', Date.now() + HOUR), 'b@x': account('b@x', Date.now() + HOUR) }, 'a@x'))
  const net = stubNet(() => response({ error: 'rate limited' }, 429, '7200'))
  await quota({ account: 'b@x', fetchFn: net.fetchFn, now: Date.now() })
  const out = cli(['--kind', 'claude', '--account', 'b@x', '--max-age', '0'])
  assert.equal(out.status, 0, out.stderr)
  const report = JSON.parse(out.stdout)
  assert.equal(report.providers.claude.logged_in, true)
  assert.equal(report.providers.claude.supported, false)
  assert.deepEqual(report.providers.claude.windows, [])
  assert.match(report.providers.claude.error, /^HTTP 429/)
  assert.equal(report.providers.claude.accounts.length, 1)
  assert.equal(row(report, 'b@x').is_default, false)
  assert.equal(row(report, 'b@x').throttled, true)
  assert.ok(Date.parse(row(report, 'b@x').retry_at) > Date.now())
  assert.deepEqual(requests(), [])
})

const invalidArgs = [
  ['missing kind', []],
  ['unknown kind', ['--kind', 'missing']],
  ['kind absent from the store', ['--kind', 'grok']],
  ['account absent from the kind', ['--kind', 'claude', '--account', 'missing@x']],
  ['kind missing its value', ['--kind']],
  ['account missing its value', ['--kind', 'claude', '--account']],
  ['account followed by another option', ['--kind', 'claude', '--account', '--max-age', '0']],
  ['max-age missing its value', ['--kind', 'claude', '--max-age']],
  ['max-age not a number', ['--kind', 'claude', '--max-age', 'soon']],
  ['negative max-age', ['--kind', 'claude', '--max-age', '-1']],
  ['fractional max-age', ['--kind', 'claude', '--max-age', '0.5']],
  ['unknown option', ['--kind', 'claude', '--accounts', 'b@x']],
  ['unexpected positional argument', ['--kind', 'claude', 'b@x']],
  ['prototype constructor argument', ['--kind', 'claude', 'constructor', 'ignored']],
  ['prototype toString argument', ['--kind', 'claude', 'toString', 'ignored']],
  ['prototype __proto__ argument', ['--kind', 'claude', '__proto__', 'ignored']],
  ['duplicate kind', ['--kind', 'claude', '--kind', 'codex']],
  ['duplicate account', ['--kind', 'claude', '--account', 'a@x', '--account', 'b@x']],
  ['duplicate max-age', ['--kind', 'claude', '--max-age', '0', '--max-age', '1']],
]
for (const [name, args] of invalidArgs) {
  await acheck(`CLI quota rejects ${name} with JSON and zero requests`, async () => {
    reset(claudeStore({ 'a@x': account('a@x', Date.now() + HOUR), 'b@x': account('b@x', Date.now() + HOUR) }))
    const out = cli(args)
    assert.deepEqual(requests(), [], 'invalid selection sent a provider request')
    const error = JSON.parse(out.stdout)
    assert.equal(error.type, 'error')
    assert.equal(typeof error.message, 'string')
    assert.ok(error.message.length > 0)
    assert.notEqual(out.status, 0)
    assert.doesNotMatch(out.stdout, /fake-at|fake-rt/)
  })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
