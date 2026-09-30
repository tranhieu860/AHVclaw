// `ahv login refresh`, the refresh book and the usage book.
//
// Measured across the fleet on 29/09: `ahv login usage` asked every account's
// quota on every call (the CMS agent ~6×/hour, login-sync keepalive up to
// 8×/hour more), so Anthropic answered 429 with Retry-After ~2800–3450 s and
// kept answering it. The same call re-tried refresh tokens that had already
// been refused (`invalid_grant`) or hit a 503, every ten minutes, on some
// fifteen machines. This drives both commands with a stub fetch and a fake
// clock against a store in a temporary DSH_HOME: no network, no real tokens.
//
// Usage: node test-login-refresh-book.mjs      Exit 0 only when every check passes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const home = mkdtempSync(new URL('../../../../login-book-', import.meta.url).pathname)
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh')
process.env.AHV_FORK ??= new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const BIN = new URL('../ahv-bot.mjs', import.meta.url).pathname
const STORE_DIR = join(process.env.DSH_HOME, 'plugins/subscriptions')
const STORE = join(STORE_DIR, 'auth.json')
const BOOK = join(STORE_DIR, 'refresh-state.json')
const CACHE = join(STORE_DIR, 'usage-cache.json')
mkdirSync(STORE_DIR, { recursive: true })

const mod = await import(BIN)
const { loginRefreshReport, loginUsageReport: usageReport, USAGE_ENDPOINTS, REFRESH_ENDPOINTS } = mod
// Deterministic jitter unless the check explicitly injects another sample.
const loginUsageReport = (opts) => usageReport({ randomFn: () => 0, ...opts })

let passed = 0, failed = 0
async function acheck(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e?.message ?? e).split('\n')[0]}`); failed++ }
}

const T0 = Date.UTC(2026, 8, 29, 10, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const USAGE_URLS = new Set(Object.values(USAGE_ENDPOINTS ?? {}).map(e => e.url))
const CLAUDE_REFRESH_URL = REFRESH_ENDPOINTS?.claude?.url

function reset(store) {
  for (const f of [STORE, BOOK, CACHE]) rmSync(f, { force: true })
  writeFileSync(STORE, JSON.stringify(store, null, 2))
}
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))
const claudeStore = (accounts, def) => ({ claude: { default: def ?? Object.keys(accounts)[0], accounts } })
const acct = (email, token, refreshToken, expiresAt) => ({ accessToken: token, refreshToken, expiresAt, emailAddress: email })

/**
 * A stub network. `refresh[refreshToken]` and `usage[accessToken]` decide each
 * answer: a function (called with the call) or a response object. Every call
 * is recorded as {url, token, refreshToken}.
 */
function stubNet({ refresh = {}, usage = {} } = {}) {
  const calls = []
  const fetchFn = async (url, init) => {
    if (url === CLAUDE_REFRESH_URL) {
      const rt = JSON.parse(init.body).refresh_token
      calls.push({ url, refreshToken: rt })
      const answer = refresh[rt]
      if (answer === undefined) throw new Error(`unexpected refresh ${rt}`)
      return typeof answer === 'function' ? answer() : answer
    }
    const token = String(init?.headers?.authorization ?? '').replace('Bearer ', '')
    calls.push({ url, token })
    const answer = usage[token]
    if (answer === undefined) throw new Error(`unexpected usage call for ${token}`)
    return typeof answer === 'function' ? answer() : answer
  }
  const count = (pred) => calls.filter(pred).length
  return {
    fetchFn,
    calls,
    usageCalls: (token) => count(c => USAGE_URLS.has(c.url) && (token === undefined || c.token === token)),
    refreshCalls: (rt) => count(c => c.url === CLAUDE_REFRESH_URL && (rt === undefined || c.refreshToken === rt)),
  }
}
const headers = (h) => ({ get: (name) => h[String(name).toLowerCase()] ?? null })
const ok = (body) => ({ ok: true, status: 200, headers: headers({}), json: async () => body, text: async () => JSON.stringify(body) })
const fail = (status, body, h = {}) => ({ ok: false, status, headers: headers(h), json: async () => JSON.parse(body), text: async () => body })
const tokens = (access, refreshToken, expiresIn = 28800) => ok({ access_token: access, refresh_token: refreshToken, expires_in: expiresIn })
const usagePct = (pct, extra = []) => ok({ limits: [{ kind: 'session', percent: pct, resets_at: new Date(T0 + 5 * HOUR).toISOString() }, ...extra] })
const INVALID_GRANT = () => fail(400, '{"error":"invalid_grant","error_description":"Refresh token not found or invalid"}')
const row = (report, kind, key) => report.providers[kind].accounts.find(r => r.key === key)

// ── login refresh ───────────────────────────────────────────────────────

await acheck('refresh renews only the session about to expire, and asks no usage endpoint', async () => {
  reset({
    ...claudeStore({
      'stale@x': acct('stale@x', 'fake-at-stale', 'fake-rt-stale', T0 + 30_000),
      'fresh@x': acct('fresh@x', 'fake-at-fresh', 'fake-rt-fresh', T0 + HOUR),
    }, 'fresh@x'),
    codex: { default: 'c1', accounts: { c1: { accessToken: 'fake-at-codex', refreshToken: 'fake-rt-codex', expiresAt: T0 - HOUR, accountId: 'c1' } } },
  })
  const net = stubNet({ refresh: { 'fake-rt-stale': tokens('fake-at-stale-2', 'fake-rt-stale-2') } })
  const report = await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 })
  assert.equal(net.usageCalls(), 0, 'no usage endpoint may be asked')
  assert.equal(net.refreshCalls(), 1, `exactly one refresh: ${JSON.stringify(net.calls.map(c => c.url))}`)
  assert.equal(net.refreshCalls('fake-rt-stale'), 1)
  const stale = row(report, 'claude', 'stale@x')
  assert.equal(stale.refreshed, true)
  assert.equal(stale.expires_at, T0 + 28800 * 1000)
  assert.equal(stale.is_default, false)
  assert.equal(stale.account, 'stale@x')
  const fresh = row(report, 'claude', 'fresh@x')
  assert.equal(fresh.refreshed, false)
  assert.equal(fresh.skipped, 'fresh')
  assert.equal(fresh.is_default, true)
  assert.equal(typeof report.checked_at, 'string')
  for (const kind of ['claude', 'codex', 'grok', 'antigravity']) assert.ok(Array.isArray(report.providers[kind]?.accounts), kind)
  const store = readJson(STORE)
  assert.equal(store.claude.accounts['stale@x'].accessToken, 'fake-at-stale-2', 'the new token is filed under its own account')
  assert.equal(store.claude.accounts['fresh@x'].accessToken, 'fake-at-fresh', 'the other account is untouched')
  assert.equal(store.claude.default, 'fresh@x')
})

await acheck('refresh re-reads the store before writing: a newer token or a new account survives', async () => {
  reset(claudeStore({ 'a@x': acct('a@x', 'fake-at-a', 'fake-rt-a', T0 - MIN) }))
  const net = stubNet({
    refresh: {
      'fake-rt-a': () => {
        // Another process (login-sync, the web plugin) refreshed meanwhile.
        const s = readJson(STORE)
        s.claude.accounts['a@x'] = acct('a@x', 'fake-at-a-newer', 'fake-rt-a-newer', T0 + 20 * HOUR)
        s.claude.accounts['b@x'] = acct('b@x', 'fake-at-b', 'fake-rt-b', T0 + 20 * HOUR)
        writeFileSync(STORE, JSON.stringify(s))
        return tokens('fake-at-a-older', 'fake-rt-a-older')
      },
    },
  })
  await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 })
  const s = readJson(STORE)
  assert.equal(s.claude.accounts['a@x'].accessToken, 'fake-at-a-newer', 'an older token replaced a newer one')
  assert.ok(s.claude.accounts['b@x'], 'an account added meanwhile was lost')
})

await acheck('invalid_grant: the same refresh token is not tried again for 6 hours', async () => {
  reset(claudeStore({ 'dead@x': acct('dead@x', 'fake-at-dead', 'fake-rt-dead', T0 - HOUR) }))
  const net = stubNet({ refresh: { 'fake-rt-dead': INVALID_GRANT } })
  const r1 = await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 })
  assert.equal(net.refreshCalls(), 1)
  assert.match(row(r1, 'claude', 'dead@x').refresh_error, /invalid_grant/)
  assert.equal(row(r1, 'claude', 'dead@x').refreshed, false)
  const r2 = await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 + 6 * HOUR - MIN })
  assert.equal(net.refreshCalls(), 1, 'a refused refresh token was sent again within 6 h')
  assert.equal(row(r2, 'claude', 'dead@x').skipped, 'dead-refresh')
  assert.match(row(r2, 'claude', 'dead@x').refresh_error ?? '', /invalid_grant/, 'the skipped row still says why')
  await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 + 6 * HOUR + MIN })
  assert.equal(net.refreshCalls(), 2, 'after 6 h it is tried again')
})

await acheck('a new refresh token (login again / sync) is tried at once', async () => {
  reset(claudeStore({ 'dead@x': acct('dead@x', 'fake-at-dead', 'fake-rt-dead', T0 - HOUR) }))
  const net = stubNet({ refresh: { 'fake-rt-dead': INVALID_GRANT, 'fake-rt-relogin': tokens('fake-at-new', 'fake-rt-new') } })
  await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 })
  const s = readJson(STORE)
  s.claude.accounts['dead@x'].refreshToken = 'fake-rt-relogin'
  writeFileSync(STORE, JSON.stringify(s))
  const r = await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 + MIN })
  assert.equal(net.refreshCalls('fake-rt-relogin'), 1, 'the new refresh token was held back by the old one\'s failure')
  assert.equal(row(r, 'claude', 'dead@x').refreshed, true)
})

await acheck('HTTP 503: backed off 30 minutes', async () => {
  reset(claudeStore({ 'x@x': acct('x@x', 'fake-at-x', 'fake-rt-x', T0 - HOUR) }))
  const net = stubNet({ refresh: { 'fake-rt-x': () => fail(503, '{"error":"temporarily_unavailable"}') } })
  await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 })
  const r = await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 + 29 * MIN })
  assert.equal(net.refreshCalls(), 1, '503 retried within 30 min')
  assert.equal(row(r, 'claude', 'x@x').skipped, 'backoff')
  assert.match(row(r, 'claude', 'x@x').refresh_error, /503/)
  await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 + 31 * MIN })
  assert.equal(net.refreshCalls(), 2, '503 not retried after 30 min')
})

await acheck('HTTP 503 is not treated as a dead token (not held for 6 h)', async () => {
  reset(claudeStore({ 'x@x': acct('x@x', 'fake-at-x', 'fake-rt-x', T0 - HOUR) }))
  const net = stubNet({ refresh: { 'fake-rt-x': () => fail(503, 'upstream') } })
  await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 })
  await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 + 2 * HOUR })
  assert.equal(net.refreshCalls(), 2)
})

await acheck('network error: backed off 10 minutes', async () => {
  reset(claudeStore({ 'x@x': acct('x@x', 'fake-at-x', 'fake-rt-x', T0 - HOUR) }))
  const net = stubNet({ refresh: { 'fake-rt-x': () => { throw new Error('ECONNRESET') } } })
  await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 })
  await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 + 9 * MIN })
  assert.equal(net.refreshCalls(), 1, 'network error retried within 10 min')
  await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 + 11 * MIN })
  assert.equal(net.refreshCalls(), 2, 'network error held longer than 10 min')
})

await acheck('the refresh book is shared: a refusal seen by `login usage` holds back `login refresh`', async () => {
  reset(claudeStore({ 'dead@x': acct('dead@x', 'fake-at-dead', 'fake-rt-dead', T0 - HOUR) }))
  const net = stubNet({ refresh: { 'fake-rt-dead': INVALID_GRANT }, usage: { 'fake-at-dead': () => fail(401, 'expired') } })
  const u = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 })
  assert.match(row(u, 'claude', 'dead@x').refresh_error, /invalid_grant/)
  const r = await loginRefreshReport({ fetchFn: net.fetchFn, now: T0 + HOUR })
  assert.equal(net.refreshCalls(), 1)
  assert.equal(row(r, 'claude', 'dead@x').skipped, 'dead-refresh')
  const u2 = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + 2 * HOUR })
  assert.equal(net.refreshCalls(), 1, '`login usage` re-tried a refused refresh token')
  assert.match(row(u2, 'claude', 'dead@x').refresh_error, /invalid_grant/)
})

// ── login usage ─────────────────────────────────────────────────────────

function twoFresh() {
  reset(claudeStore({
    'a@x': acct('a@x', 'fake-at-a', 'fake-rt-a', T0 + 48 * HOUR),
    'b@x': acct('b@x', 'fake-at-b', 'fake-rt-b', T0 + 48 * HOUR),
  }, 'a@x'))
}

await acheck('every row read from the network carries read_at', async () => {
  twoFresh()
  const net = stubNet({ usage: { 'fake-at-a': usagePct(40), 'fake-at-b': usagePct(10) } })
  const u = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 })
  for (const key of ['a@x', 'b@x']) assert.equal(row(u, 'claude', key).read_at, new Date(T0).toISOString(), key)
  assert.equal(row(u, 'claude', 'a@x').cached, undefined)
})

await acheck('429 Retry-After 3000: held at least one hour, with the last reading', async () => {
  twoFresh()
  const expired = { kind: 'weekly_all', percent: 77, resets_at: new Date(T0 + 90_000).toISOString() }
  let answerA = usagePct(40, [expired])
  const net = stubNet({ usage: { 'fake-at-a': () => answerA, 'fake-at-b': usagePct(10) } })
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 })
  answerA = fail(429, '{"error":{"type":"rate_limit_error","message":"Rate limited"}}', { 'retry-after': '3000' })
  const u1 = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + MIN })
  const a1 = row(u1, 'claude', 'a@x')
  assert.match(a1.error, /^HTTP 429/, 'the error string the CMS agent matches must stay')
  assert.equal(a1.throttled, true)
  assert.equal(a1.retry_at, new Date(T0 + MIN + HOUR).toISOString())
  assert.equal(net.usageCalls('fake-at-a'), 2)
  const u2 = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + 2 * MIN })
  assert.equal(net.usageCalls('fake-at-a'), 2, 'the throttled account was asked again')
  assert.equal(net.usageCalls('fake-at-b'), 3, 'the other account must still be asked')
  const a2 = row(u2, 'claude', 'a@x')
  assert.equal(a2.throttled, true)
  assert.match(a2.error, /^HTTP 429/)
  assert.equal(a2.retry_at, new Date(T0 + MIN + HOUR).toISOString())
  assert.equal(a2.read_at, new Date(T0).toISOString(), 'the last good reading is dated')
  assert.deepEqual(a2.windows.map(w => w.used_percent), [40], 'last reading shown, minus the window already reset')
  assert.equal(u2.providers.claude.throttled, undefined)
  assert.equal(row(u2, 'claude', 'b@x').throttled, undefined)
  answerA = usagePct(55)
  const u3 = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + MIN + HOUR + 1000 })
  assert.equal(net.usageCalls('fake-at-a'), 3, 'asked again once Retry-After passed')
  assert.equal(row(u3, 'claude', 'a@x').throttled, undefined)
  assert.equal(row(u3, 'claude', 'a@x').windows[0].used_percent, 55)
})

await acheck('Retry-After is capped at 6 hours before jitter', async () => {
  twoFresh()
  const net = stubNet({ usage: { 'fake-at-a': () => fail(429, 'Rate limited', { 'retry-after': '99999' }), 'fake-at-b': usagePct(10) } })
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 })
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + 6 * HOUR - MIN })
  assert.equal(net.usageCalls('fake-at-a'), 1)
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + 6 * HOUR + MIN })
  assert.equal(net.usageCalls('fake-at-a'), 2, 'held longer than 6 h')
})

await acheck('429 without Retry-After holds at least one hour', async () => {
  twoFresh()
  const net = stubNet({ usage: { 'fake-at-a': () => fail(429, 'Rate limited'), 'fake-at-b': usagePct(10) } })
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 })
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + HOUR - MIN })
  assert.equal(net.usageCalls('fake-at-a'), 1)
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + HOUR + MIN })
  assert.equal(net.usageCalls('fake-at-a'), 2)
})

await acheck('Retry-After as an HTTP date', async () => {
  twoFresh()
  const when = new Date(T0 + 90 * MIN).toUTCString()
  const net = stubNet({ usage: { 'fake-at-a': () => fail(429, 'Rate limited', { 'retry-after': when }), 'fake-at-b': usagePct(10) } })
  const u = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 })
  assert.equal(row(u, 'claude', 'a@x').retry_at, new Date(T0 + 90 * MIN).toISOString())
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + 89 * MIN })
  assert.equal(net.usageCalls('fake-at-a'), 1)
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + 91 * MIN })
  assert.equal(net.usageCalls('fake-at-a'), 2)
})

await acheck('a reading older than 24 h is not offered while throttled', async () => {
  twoFresh()
  let answerA = usagePct(40)
  const net = stubNet({ usage: { 'fake-at-a': () => answerA, 'fake-at-b': usagePct(10) } })
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 })
  answerA = fail(429, 'Rate limited', { 'retry-after': '3000' })
  const u = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + 25 * HOUR })
  const a = row(u, 'claude', 'a@x')
  assert.equal(a.throttled, true)
  assert.deepEqual(a.windows, [])
  assert.equal(a.read_at, undefined)
})

await acheck('--max-age answers from the book without asking the network', async () => {
  twoFresh()
  const net = stubNet({ usage: { 'fake-at-a': usagePct(40), 'fake-at-b': usagePct(10) } })
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 })
  const u = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + 100_000, maxAgeSec: 300 })
  assert.equal(net.usageCalls(), 2, 'a fresh-enough reading was asked again')
  const a = row(u, 'claude', 'a@x')
  assert.equal(a.cached, true)
  assert.equal(a.read_at, new Date(T0).toISOString())
  assert.equal(a.windows[0].used_percent, 40)
  assert.equal(u.providers.claude.windows[0].used_percent, 40, 'top level still mirrors the default account')
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + 100_000, maxAgeSec: 50 })
  assert.equal(net.usageCalls(), 4, 'a reading older than --max-age must be asked again')
})

await acheck('without --max-age every account is still asked (old behaviour)', async () => {
  twoFresh()
  const net = stubNet({ usage: { 'fake-at-a': usagePct(40), 'fake-at-b': usagePct(10) } })
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 })
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + 1000 })
  assert.equal(net.usageCalls(), 4)
})

await acheck('the book files hold no token and are 0600', async () => {
  reset(claudeStore({
    'a@x': acct('a@x', 'fake-at-SECRET-a', 'fake-rt-SECRET-a', T0 - HOUR),
    'b@x': acct('b@x', 'fake-at-SECRET-b', 'fake-rt-SECRET-b', T0 + 48 * HOUR),
  }))
  const net = stubNet({
    refresh: { 'fake-rt-SECRET-a': INVALID_GRANT },
    usage: { 'fake-at-SECRET-a': () => fail(429, 'x', { 'retry-after': '60' }), 'fake-at-SECRET-b': usagePct(3) },
  })
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 })
  for (const f of [BOOK, CACHE]) {
    assert.ok(existsSync(f), `${f} not written`)
    const text = readFileSync(f, 'utf8')
    assert.doesNotMatch(text, /SECRET/, `${f} holds a token`)
    assert.equal(statSync(f).mode & 0o777, 0o600, `${f} mode`)
  }
})

await acheck('a book entry written by another command meanwhile is kept', async () => {
  twoFresh()
  const net = stubNet({
    usage: {
      'fake-at-a': () => {
        // `login refresh` (or a second `login usage`) finished during this call.
        writeFileSync(CACHE, JSON.stringify({ codex: { other: { read_at: T0, supported: true, windows: [] } } }))
        return usagePct(40)
      },
      'fake-at-b': usagePct(10),
    },
  })
  await loginUsageReport({ fetchFn: net.fetchFn, now: T0 })
  const cache = readJson(CACHE)
  assert.ok(cache.codex?.other, 'the other command\'s entry was overwritten')
  assert.ok(cache.claude?.['a@x'] && cache.claude?.['b@x'])
})

// A3: consecutive 429s survive disk reload even without a successful reading.
await acheck('429 sequence holds 1/2/4/6/6 hours and a 2xx resets the sequence', async () => {
  reset(claudeStore({ 'a@x': acct('a@x', 'fake-at-a', 'fake-rt-a', T0 + 72 * HOUR) }))
  let answer = fail(429, 'Rate limited')
  const net = stubNet({ usage: { 'fake-at-a': () => answer } })
  let now = T0
  for (const [index, hours] of [1, 2, 4, 6, 6].entries()) {
    const report = await loginUsageReport({ fetchFn: net.fetchFn, now })
    assert.equal(Date.parse(row(report, 'claude', 'a@x').retry_at) - now, hours * HOUR)
    assert.equal(readJson(CACHE).claude['a@x'].consecutive_429, index + 1)
    assert.equal(net.usageCalls(), index + 1)
    now += hours * HOUR
    await loginUsageReport({ fetchFn: net.fetchFn, now: now - 1, maxAgeSec: 0 })
    assert.equal(net.usageCalls(), index + 1, 'no request before hold ends')
  }
  answer = usagePct(12)
  await loginUsageReport({ fetchFn: net.fetchFn, now })
  assert.equal(readJson(CACHE).claude['a@x'].consecutive_429, 0)
  answer = fail(429, 'Rate limited')
  const report = await loginUsageReport({ fetchFn: net.fetchFn, now: now + 1 })
  assert.equal(Date.parse(row(report, 'claude', 'a@x').retry_at) - (now + 1), HOUR)
})

for (const status of [200, 204]) {
  await acheck(`HTTP ${status} with unreadable JSON resets 429 count without caching an error reading`, async () => {
    reset(claudeStore({ 'a@x': acct('a@x', 'fake-at-a', 'fake-rt-a', T0 + 48 * HOUR) }))
    let answer = fail(429, 'Rate limited')
    const net = stubNet({ usage: { 'fake-at-a': () => answer } })
    await loginUsageReport({ fetchFn: net.fetchFn, now: T0 })
    answer = { ...ok({}), status, json: async () => { throw new SyntaxError('unreadable JSON') } }
    const errored = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + HOUR })
    assert.equal(row(errored, 'claude', 'a@x').error, 'unreadable JSON')
    assert.equal(row(errored, 'claude', 'a@x').read_at, undefined, 'an unusable body is not a reading')
    assert.equal(readJson(CACHE).claude['a@x'].consecutive_429, 0, 'every 2xx resets the hold sequence')
    answer = fail(429, 'Rate limited')
    const next = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + HOUR + 1 })
    assert.equal(Date.parse(row(next, 'claude', 'a@x').retry_at) - (T0 + HOUR + 1), HOUR)
  })
}

await acheck('jitter adds 0..10% after the six-hour cap and respects Retry-After', async () => {
  for (const [sample, expected] of [[0, 6 * HOUR], [0.5, 6.3 * HOUR], [1, 6.6 * HOUR]]) {
    reset(claudeStore({ 'a@x': acct('a@x', 'fake-at-a', 'fake-rt-a', T0 + 48 * HOUR) }))
    const net = stubNet({ usage: { 'fake-at-a': fail(429, 'Rate limited', { 'retry-after': '99999' }) } })
    const r = await loginUsageReport({ fetchFn: net.fetchFn, now: T0, randomFn: () => sample })
    assert.equal(Date.parse(row(r, 'claude', 'a@x').retry_at) - T0, expected)
  }
  reset(claudeStore({ 'a@x': acct('a@x', 'fake-at-a', 'fake-rt-a', T0 + 48 * HOUR) }))
  const net = stubNet({ usage: { 'fake-at-a': fail(429, 'Rate limited', { 'retry-after': '5400' }) } })
  const r = await loginUsageReport({ fetchFn: net.fetchFn, now: T0, randomFn: () => 0.5 })
  assert.equal(Date.parse(row(r, 'claude', 'a@x').retry_at) - T0, 94.5 * MIN)
})

await acheck('an old usage book without the counter still serves cache and holds, then starts at one', async () => {
  reset(claudeStore({ 'a@x': acct('a@x', 'fake-at-a', 'fake-rt-a', T0 + 48 * HOUR) }))
  writeFileSync(CACHE, JSON.stringify({ claude: { 'a@x': {
    read_at: T0, supported: true, windows: [{ kind: 'session', used_percent: 35, resets_at: null }],
    throttled_until: T0 + MIN, throttle_error: 'HTTP 429',
  } } }))
  const net = stubNet({ usage: { 'fake-at-a': fail(429, 'Rate limited') } })
  const held = await loginUsageReport({ fetchFn: net.fetchFn, now: T0, maxAgeSec: 0 })
  assert.equal(row(held, 'claude', 'a@x').throttled, true)
  assert.equal(net.usageCalls(), 0)
  const cached = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + MIN, maxAgeSec: 300 })
  assert.equal(row(cached, 'claude', 'a@x').cached, true)
  assert.equal(row(cached, 'claude', 'a@x').windows[0].used_percent, 35)
  const r = await loginUsageReport({ fetchFn: net.fetchFn, now: T0 + MIN, maxAgeSec: 0 })
  assert.equal(Date.parse(row(r, 'claude', 'a@x').retry_at) - (T0 + MIN), HOUR)
  assert.equal(readJson(CACHE).claude['a@x'].consecutive_429, 1)
})

// ── the CLI itself ──────────────────────────────────────────────────────

const stubFetch = join(home, 'no-net.mjs')
writeFileSync(stubFetch, 'globalThis.fetch = async () => { throw new Error("network used in test") }\n')
function cli(args) {
  return spawnSync(process.execPath, ['--import', stubFetch, BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, DSH_HOME: process.env.DSH_HOME },
  })
}

await acheck('`ahv login refresh --json` prints the report and exits 0', async () => {
  reset(claudeStore({ 'a@x': acct('a@x', 'fake-at-a', 'fake-rt-a', Date.now() + 48 * HOUR) }))
  const out = cli(['login', 'refresh', '--json'])
  assert.equal(out.status, 0, out.stderr)
  const doc = JSON.parse(out.stdout)
  assert.equal(doc.providers.claude.accounts[0].skipped, 'fresh')
  assert.doesNotMatch(out.stdout, /fake-at|fake-rt/)
})

await acheck('`ahv login refresh` on an unreadable store answers an error document', async () => {
  reset({})
  writeFileSync(STORE, '{not json')
  const out = cli(['login', 'refresh', '--json'])
  const doc = JSON.parse(out.stdout)
  assert.equal(doc.type, 'error')
  assert.notEqual(out.status, 0)
})

await acheck('`ahv login usage --max-age` rejects a non-number', async () => {
  reset({})
  const out = cli(['login', 'usage', '--json', '--max-age', 'soon'])
  assert.equal(JSON.parse(out.stdout).type, 'error')
  assert.equal(out.status, 2)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
