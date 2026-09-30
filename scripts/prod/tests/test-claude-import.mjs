// Claude must be importable like the other two.
//
// The subscriptions plugin exposes a provider only once its own store holds a
// session. For Claude it never runs an OAuth flow — it copies whatever the
// `claude` CLI stored — so a bot user that never ran `claude` had no Claude
// provider at all, while requests naming a Claude model still answered by
// falling through to the router.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const mod = await import(new URL('../ahv-bot.mjs', import.meta.url).href)
const { importCliCredentials, withAccountSession } = mod

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (error) { console.log(`  FAIL  ${name}\n        ${error.message}`); failed++ }
}
// The provider profile is never reached from a test: offline unless a case says otherwise.
const offline = async () => { throw new Error('offline test') }
function makeHome() { return mkdtempSync(join(tmpdir(), 'ahvhome-')) }
function writeClaude(home, oauth, dir = '.claude') {
  const d = join(home, dir)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
  return d
}
const future = Date.now() + 3600_000

await check('a Claude CLI login is imported into the store', async () => {
  const home = makeHome()
  writeClaude(home, { accessToken: 'a1', refreshToken: 'r1', expiresAt: future, scopes: ['user:inference'] })
  const report = await importCliCredentials({ home, fetchFn: offline })
  assert.equal(report.claude?.imported, true, JSON.stringify(report.claude))
  const store = JSON.parse(readFileSync(join(home, '.dsh/plugins/subscriptions/auth.json'), 'utf8'))
  assert.equal(store.claude.accessToken, 'a1')
  assert.equal(store.claude.refreshToken, 'r1')
  assert.equal(store.claude.expiresAt, future)
})

await check('CLAUDE_CONFIG_DIR redirects where the login is read from', async () => {
  const home = makeHome()
  const shared = mkdtempSync(join(tmpdir(), 'shared-'))
  writeFileSync(join(shared, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'shared', refreshToken: 'rs', expiresAt: future } }))
  const report = await importCliCredentials({ home, claudeConfigDir: shared, fetchFn: offline })
  assert.equal(report.claude?.imported, true, JSON.stringify(report.claude))
  const store = JSON.parse(readFileSync(join(home, '.dsh/plugins/subscriptions/auth.json'), 'utf8'))
  assert.equal(store.claude.accessToken, 'shared')
})

await check('a missing Claude login reports why, and imports nothing', async () => {
  const home = makeHome()
  const report = await importCliCredentials({ home, fetchFn: offline })
  assert.equal(report.claude?.imported, false)
  assert.equal(report.claude?.reason, 'cli_not_logged_in')
  assert.equal(existsSync(join(home, '.dsh/plugins/subscriptions/auth.json')), false)
})

await check('a corrupt credentials file is reported, not thrown', async () => {
  const home = makeHome()
  const d = join(home, '.claude'); mkdirSync(d, { recursive: true })
  writeFileSync(join(d, '.credentials.json'), '{not json')
  const report = await importCliCredentials({ home, fetchFn: offline })
  assert.equal(report.claude?.reason, 'cli_unreadable')
})

await check('a login without the tokens is not imported', async () => {
  const home = makeHome()
  writeClaude(home, { expiresAt: future })
  const report = await importCliCredentials({ home, fetchFn: offline })
  assert.equal(report.claude?.imported, false)
  assert.equal(report.claude?.reason, 'cli_not_logged_in')
})

await check('a newer token already in the store is left alone', async () => {
  const home = makeHome()
  writeClaude(home, { accessToken: 'old', refreshToken: 'r', expiresAt: future })
  const dir = join(home, '.dsh/plugins/subscriptions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    claude: { accessToken: 'newer', refreshToken: 'r2', expiresAt: future + 60_000 },
  }))
  const report = await importCliCredentials({ home, fetchFn: offline })
  assert.equal(report.claude?.reason, 'plugin_token_newer')
  const store = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))
  assert.equal(store.claude.accessToken, 'newer')
})

await check('a bare credentials blob without the wrapper key still works', async () => {
  const home = makeHome()
  const d = join(home, '.claude'); mkdirSync(d, { recursive: true })
  writeFileSync(join(d, '.credentials.json'),
    JSON.stringify({ accessToken: 'bare', refreshToken: 'rb', expiresAt: future }))
  const report = await importCliCredentials({ home, fetchFn: offline })
  assert.equal(report.claude?.imported, true, JSON.stringify(report.claude))
})

// A store the plugin keeps per account must keep every account through an import.
function seedStore(home, data) {
  const dir = join(home, '.dsh/plugins/subscriptions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'auth.json'), JSON.stringify(data))
  return () => JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))
}
const past = Date.now() - 3600_000
const perAccount = () => ({
  claude: {
    default: 'a@claude.test',
    accounts: {
      'a@claude.test': { accessToken: 'aa', refreshToken: 'ra', expiresAt: past, emailAddress: 'a@claude.test' },
      'b@claude.test': { accessToken: 'ab', refreshToken: 'rb', expiresAt: past, emailAddress: 'b@claude.test' },
    },
  },
  codex: { default: 'c', accounts: { c: { accessToken: 'ac', refreshToken: 'rc', expiresAt: past, accountId: 'c' } }, aliases: { old: 'c' } },
})

await check('importing into a per-account store keeps every other account', async () => {
  const home = makeHome()
  const read = seedStore(home, perAccount())
  writeClaude(home, { accessToken: 'new', refreshToken: 'rnew', expiresAt: future })
  const report = await importCliCredentials({ home, fetchFn: offline })
  assert.equal(report.claude?.imported, true, JSON.stringify(report.claude))
  const store = read()
  assert.equal(store.claude.accessToken, undefined, 'the entry became a bare session the plugin reads as one account')
  assert.equal(store.claude.accounts['a@claude.test'].accessToken, 'aa')
  assert.equal(store.claude.accounts['b@claude.test'].accessToken, 'ab')
  assert.ok(Object.values(store.claude.accounts).some(account => account.accessToken === 'new'), 'the imported login is missing')
  assert.equal(store.claude.default, 'a@claude.test')
  assert.deepEqual(store.codex, perAccount().codex)
})

await check('importing a login that already sits in an account renews that account', async () => {
  const home = makeHome()
  const read = seedStore(home, perAccount())
  writeClaude(home, { accessToken: 'renewed', refreshToken: 'rb', expiresAt: future })
  await importCliCredentials({ home, fetchFn: offline })
  const store = read()
  assert.equal(store.claude.accounts['b@claude.test'].accessToken, 'renewed')
  assert.equal(store.claude.accounts['b@claude.test'].emailAddress, 'b@claude.test')
  assert.equal(Object.keys(store.claude.accounts).length, 2)
})

await check('a newer token in the matching account is left alone', async () => {
  const home = makeHome()
  const data = perAccount()
  data.claude.accounts['b@claude.test'].expiresAt = future + 60_000
  const read = seedStore(home, data)
  writeClaude(home, { accessToken: 'older', refreshToken: 'rb', expiresAt: future })
  const report = await importCliCredentials({ home, fetchFn: offline })
  assert.equal(report.claude?.reason, 'plugin_token_newer')
  assert.equal(read().claude.accounts['b@claude.test'].accessToken, 'ab')
})

// Codex logins are filed by workspace + user from the id token, as the plugin files them.
const jwt = claims => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')
function writeCodex(home, { user, refresh, exp }) {
  const d = join(home, '.codex')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'auth.json'), JSON.stringify({ tokens: {
    access_token: jwt({ exp: Math.floor(exp / 1000) }),
    refresh_token: refresh,
    account_id: 'ws-123',
    id_token: jwt({ email: `${user}@codex.test`, 'https://api.openai.com/auth': { chatgpt_user_id: user } }),
  } }))
}
const codexKey = user => JSON.stringify(['ws-123', 'user', user])
const codexStore = () => ({
  codex: {
    default: codexKey('u_1'),
    accounts: {
      [codexKey('u_1')]: { accessToken: 'c1', refreshToken: 'r1', expiresAt: past, accountId: 'ws-123' },
      [codexKey('u_2')]: { accessToken: 'c2', refreshToken: 'r2', expiresAt: past, accountId: 'ws-123' },
    },
    aliases: { 'ws-123': codexKey('u_1') },
  },
})

await check('a Codex CLI login renews the account the plugin keys it under, not a new one', async () => {
  const home = makeHome()
  const read = seedStore(home, codexStore())
  writeCodex(home, { user: 'u_2', refresh: 'r2-new', exp: future })
  const report = await importCliCredentials({ home, fetchFn: offline })
  assert.equal(report.codex?.imported, true, JSON.stringify(report.codex))
  const store = read()
  assert.deepEqual(Object.keys(store.codex.accounts).sort(), [codexKey('u_1'), codexKey('u_2')].sort(), 'an extra Codex account appeared')
  assert.equal(store.codex.accounts[codexKey('u_2')].refreshToken, 'r2-new')
  assert.equal(store.codex.accounts[codexKey('u_1')].accessToken, 'c1')
  assert.deepEqual(store.codex.aliases, codexStore().codex.aliases)
})

await check('a Codex CLI login for a user not in the store is added beside the others', async () => {
  const home = makeHome()
  const read = seedStore(home, codexStore())
  writeCodex(home, { user: 'u_3', refresh: 'r3', exp: future })
  await importCliCredentials({ home, fetchFn: offline })
  const store = read()
  assert.equal(store.codex.accounts[codexKey('u_3')].refreshToken, 'r3')
  assert.equal(Object.keys(store.codex.accounts).length, 3)
})

await check('a store that exists but cannot be read is left alone', async () => {
  const home = makeHome()
  const dir = join(home, '.dsh/plugins/subscriptions')
  mkdirSync(dir, { recursive: true })
  const torn = JSON.stringify(perAccount()).slice(0, 60)
  writeFileSync(join(dir, 'auth.json'), torn)
  writeClaude(home, { accessToken: 'new', refreshToken: 'rnew', expiresAt: future })
  const report = await importCliCredentials({ home, fetchFn: offline })
  assert.equal(report.claude?.reason, 'store_unreadable')
  assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), torn, 'the unreadable store was rewritten')
})

await check('a Claude login the CLI refreshed is filed under its account, asked of the provider', async () => {
  const home = makeHome()
  const read = seedStore(home, perAccount())
  writeClaude(home, { accessToken: 'b-new', refreshToken: 'rb-new', expiresAt: future })
  let asked = 0
  const profile = async (url, init) => {
    asked++
    assert.equal(init.headers.authorization, 'Bearer b-new')
    return new Response(JSON.stringify({ account: { email: 'b@claude.test' } }), { status: 200 })
  }
  await importCliCredentials({ home, fetchFn: profile })
  const store = read()
  assert.equal(asked, 1)
  assert.deepEqual(Object.keys(store.claude.accounts).sort(), ['a@claude.test', 'b@claude.test'], 'a duplicate account appeared')
  assert.equal(store.claude.accounts['b@claude.test'].refreshToken, 'rb-new')
  assert.equal(store.claude.accounts['a@claude.test'].accessToken, 'aa')
})

await check('fields the CLI file lacks do not blank what the store knows (via a Codex alias)', async () => {
  const home = makeHome()
  const data = codexStore()
  data.codex.accounts[codexKey('u_1')].idToken = 'keep-me'
  const read = seedStore(home, data)
  // No id token: the login is known only by its workspace, which aliases u_1.
  const d = join(home, '.codex')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt({ exp: Math.floor(future / 1000) }), refresh_token: 'r1-new', account_id: 'ws-123' } }))
  await importCliCredentials({ home, fetchFn: offline })
  const store = read()
  assert.equal(Object.keys(store.codex.accounts).length, 2, 'an extra Codex account appeared')
  assert.equal(store.codex.accounts[codexKey('u_1')].refreshToken, 'r1-new')
  assert.equal(store.codex.accounts[codexKey('u_1')].idToken, 'keep-me')
})

// The login commands that rewrite the store, run as the CLI runs them.
function runLogin(home, ...args) {
  const r = spawnSync(process.execPath, [new URL('../ahv-bot.mjs', import.meta.url).pathname, 'login', ...args], {
    env: { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh') }, encoding: 'utf8',
  })
  return { status: r.status, out: r.stdout }
}

await check('login use and login forget keep the entry\'s Codex aliases', async () => {
  const home = makeHome()
  const read = seedStore(home, codexStore())
  assert.equal(runLogin(home, 'use', 'codex', codexKey('u_2')).status, 0)
  assert.deepEqual(read().codex.aliases, codexStore().codex.aliases, 'use dropped the aliases')
  assert.equal(runLogin(home, 'forget', 'codex', codexKey('u_1')).status, 0)
  assert.deepEqual(read().codex.aliases, codexStore().codex.aliases, 'forget dropped the aliases')
  assert.deepEqual(Object.keys(read().codex.accounts), [codexKey('u_2')])
})

await check('login use refuses to rewrite a store it cannot read', async () => {
  const home = makeHome()
  const dir = join(home, '.dsh/plugins/subscriptions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'auth.json'), '{"codex": {"default"')
  const r = runLogin(home, 'use', 'codex', 'x')
  assert.notEqual(r.status, 0)
  assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), '{"codex": {"default"')
})

await check('putting a session back keeps the entry\'s other fields (Codex aliases)', async () => {
  const entry = withAccountSession(perAccount().codex, 'c', { accessToken: 'x', refreshToken: 'y', expiresAt: future, accountId: 'c' })
  assert.deepEqual(entry.aliases, { old: 'c' })
  assert.equal(entry.accounts.c.accessToken, 'x')
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
