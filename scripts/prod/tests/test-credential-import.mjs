#!/usr/bin/env node
// Tests for CLI-native credential import into the subscriptions plugin store.
// Run: node ~/.ahv/tests/test-credential-import.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ahv-bot.mjs reads ~/.ahv/env, DSH_HOME and CLAUDE_CONFIG_DIR when imported or called. Resolve the bot first (installed
// as ~/.ahv/bin/ahv-bot.mjs next to ~/.ahv/tests, or in the repo next to tests/), then point every one of them at an
// empty scratch home so a machine's real logins are never read.
const here = dirname(fileURLToPath(import.meta.url))
const botPath = [join(here, '..', 'ahv-bot.mjs'), join(here, '..', 'bin', 'ahv-bot.mjs')].find(existsSync)
assert.ok(botPath, 'ahv-bot.mjs not found next to the tests')
process.env.HOME = mkdtempSync(join(tmpdir(), 'ahv-cred-home-'))
for (const name of ['CLAUDE_CONFIG_DIR', 'DSH_HOME', 'AHV_FORK']) delete process.env[name]

const { importCliCredentials: importWithRealFetch, decodeJwtExpiry } = await import(pathToFileURL(botPath).href)
// The Claude import asks api.anthropic.com for the account address; tests never reach the network.
const offline = async () => { throw new TypeError('network disabled in tests') }
const importCliCredentials = (options) => importWithRealFetch({ fetchFn: offline, ...options })

let passed = 0
let failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}

// Build a JWT whose payload carries the given `exp` (seconds).
function jwt(expSeconds) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64({ exp: expSeconds })}.sig`
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ahv-cred-'))
  mkdirSync(join(root, '.codex'), { recursive: true })
  mkdirSync(join(root, '.grok'), { recursive: true })
  mkdirSync(join(root, '.dsh', 'plugins', 'subscriptions'), { recursive: true })
  return root
}

const storePath = (root) => join(root, '.dsh', 'plugins', 'subscriptions', 'auth.json')
const readStore = (root) => JSON.parse(readFileSync(storePath(root), 'utf8'))

console.log('decodeJwtExpiry')

await test('reads exp from a JWT payload', async () => {
  assert.equal(decodeJwtExpiry(jwt(1800000000)), 1800000000 * 1000)
})

await test('returns null for a malformed token', async () => {
  assert.equal(decodeJwtExpiry('not-a-jwt'), null)
  assert.equal(decodeJwtExpiry(''), null)
  assert.equal(decodeJwtExpiry(undefined), null)
})

console.log('importCliCredentials')

await test('imports codex tokens into plugin shape', async () => {
  const root = sandbox()
  const exp = Math.floor(Date.now() / 1000) + 3600
  writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt(exp),
      access_token: jwt(exp),
      refresh_token: 'refresh-abc',
      account_id: 'acct-123',
    },
    last_refresh: new Date().toISOString(),
  }))

  const report = await importCliCredentials({ home: root })

  assert.equal(report.codex.imported, true)
  const entry = readStore(root).codex
  assert.equal(entry.accessToken, undefined, 'a fresh import must file the session under accounts, not bare')
  const accounts = Object.values(entry.accounts)
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].refreshToken, 'refresh-abc')
  assert.equal(accounts[0].accountId, 'acct-123')
  assert.equal(accounts[0].expiresAt, exp * 1000)
})

await test('imports grok tokens into plugin shape', async () => {
  const root = sandbox()
  writeFileSync(join(root, '.grok', 'auth.json'), JSON.stringify({
    access_token: 'grok-access',
    refresh_token: 'grok-refresh',
    expires_at: 1800000000000,
    email: 'user@example.com',
  }))

  const report = await importCliCredentials({ home: root })

  assert.equal(report.grok.imported, true)
  const entry = readStore(root).grok
  assert.equal(entry.accessToken, undefined, 'a fresh import must file the session under accounts, not bare')
  assert.deepEqual(Object.keys(entry.accounts), [entry.default])
  const grok = entry.accounts[entry.default]
  assert.equal(grok.accessToken, 'grok-access')
  assert.equal(grok.refreshToken, 'grok-refresh')
  assert.equal(grok.expiresAt, 1800000000000)
})

await test('keeps a newer plugin token over an older CLI token', async () => {
  const root = sandbox()
  const older = Math.floor(Date.now() / 1000) + 60
  writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({
    tokens: { access_token: jwt(older), refresh_token: 'old', account_id: 'a' },
  }))
  writeFileSync(storePath(root), JSON.stringify({
    codex: { accessToken: 'newer', refreshToken: 'newer', expiresAt: Date.now() + 7200_000 },
  }))

  const report = await importCliCredentials({ home: root })

  assert.equal(report.codex.imported, false)
  assert.equal(report.codex.reason, 'plugin_token_newer')
  assert.equal(readStore(root).codex.accessToken, 'newer')
})

await test('reports absent CLI credentials without writing a store', async () => {
  const root = sandbox()

  const report = await importCliCredentials({ home: root })

  assert.equal(report.codex.imported, false)
  assert.equal(report.codex.reason, 'cli_not_logged_in')
  assert.equal(report.grok.imported, false)
  assert.equal(existsSync(storePath(root)), false)
})

await test('leaves other providers untouched', async () => {
  const root = sandbox()
  writeFileSync(join(root, '.grok', 'auth.json'), JSON.stringify({
    access_token: 'g', refresh_token: 'r', expires_at: 1800000000000,
  }))
  writeFileSync(storePath(root), JSON.stringify({
    claude: { accessToken: 'claude-token', expiresAt: 1800000000000 },
  }))

  await importCliCredentials({ home: root })

  assert.equal(readStore(root).claude.accessToken, 'claude-token')
})

await test('tolerates malformed CLI credential files', async () => {
  const root = sandbox()
  writeFileSync(join(root, '.codex', 'auth.json'), 'not json at all')

  const report = await importCliCredentials({ home: root })

  assert.equal(report.codex.imported, false)
  assert.equal(report.codex.reason, 'cli_unreadable')
})

await test('skips a codex file with no usable tokens', async () => {
  const root = sandbox()
  writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'apikey', tokens: {} }))

  const report = await importCliCredentials({ home: root })

  assert.equal(report.codex.imported, false)
  assert.equal(report.codex.reason, 'cli_not_logged_in')
})

await test('writes the store with owner-only permissions', async () => {
  const root = sandbox()
  writeFileSync(join(root, '.grok', 'auth.json'), JSON.stringify({
    access_token: 'g', refresh_token: 'r', expires_at: 1800000000000,
  }))

  await importCliCredentials({ home: root })

  assert.equal(statSync(storePath(root)).mode & 0o777, 0o600)
})

// #1430: `{ ...existing, ...session }` wrote a bare session next to the `accounts`
// map of an existing entry; the plugin then wrapped that whole entry as one more account.
const grokCli = (root, extra = {}) => writeFileSync(join(root, '.grok', 'auth.json'), JSON.stringify({
  access_token: 'cli-new', refresh_token: 'cli-new-r', expires_at: 1800000000000, email: 'a@example.test', ...extra,
}))
const grokSession = (n, expiresAt, account = 'a@example.test') => ({ accessToken: `old-${n}`, refreshToken: `old-${n}-r`, expiresAt, account })
const seedStore = (root, grok) => writeFileSync(storePath(root), JSON.stringify({ grok }))
const accountsOf = (entry) => JSON.stringify(entry.accounts)

await test('importing into a multi-account entry adds no bare session beside accounts', async () => {
  const root = sandbox()
  grokCli(root)
  seedStore(root, { default: 'b@example.test', accounts: { 'b@example.test': grokSession(2, 1700000000000, 'b@example.test') } })
  const report = await importCliCredentials({ home: root })
  assert.equal(report.grok.imported, true)
  const entry = readStore(root).grok
  assert.equal(entry.accessToken, undefined, 'a bare session was written beside the accounts')
  assert.deepEqual(Object.keys(entry.accounts).sort(), ['a@example.test', 'b@example.test'])
  assert.equal(entry.accounts['a@example.test'].accessToken, 'cli-new')
  assert.equal(entry.default, 'b@example.test')
})

await test('importing over a hybrid entry (bare session beside accounts) flattens it', async () => {
  const root = sandbox()
  grokCli(root)
  const old = grokSession(1, 1700000000000)
  seedStore(root, { ...old, default: 'a@example.test', accounts: { 'a@example.test': old, 'b@example.test': grokSession(2, 1700000000000, 'b@example.test') } })
  const report = await importCliCredentials({ home: root })
  assert.equal(report.grok.imported, true)
  const entry = readStore(root).grok
  assert.equal(entry.accessToken, undefined)
  assert.deepEqual(Object.keys(entry.accounts).sort(), ['a@example.test', 'b@example.test'])
  assert.equal(entry.accounts['a@example.test'].accessToken, 'cli-new')
  assert.equal(accountsOf(entry).includes('"accounts"'), false, 'an account still wraps an accounts map')
})

await test('importing over an entry nested 122 levels deep flattens it and keeps every account', async () => {
  const root = sandbox()
  grokCli(root)
  const old = grokSession(1, 1700000000000)
  let nested = { ...old, accounts: { 'a@example.test': old, 'deep@example.test': grokSession(3, 1700000000000, 'deep@example.test') } }
  for (let i = 0; i < 122; i++) nested = { ...nested, default: 'a@example.test', accounts: { 'a@example.test': nested } }
  seedStore(root, nested)
  const report = await importCliCredentials({ home: root })
  assert.equal(report.grok.imported, true)
  const entry = readStore(root).grok
  assert.deepEqual(Object.keys(entry.accounts).sort(), ['a@example.test', 'deep@example.test'])
  assert.equal(entry.accounts['deep@example.test'].accessToken, 'old-3')
  assert.equal(accountsOf(entry).includes('"accounts"'), false)
  assert.ok(readFileSync(storePath(root), 'utf8').length < 3000, 'the store did not shrink')
})

await test('a bare legacy entry is replaced by the accounts form on import, keeping its account', async () => {
  const root = sandbox()
  grokCli(root)
  seedStore(root, grokSession(1, 1700000000000))
  const report = await importCliCredentials({ home: root })
  assert.equal(report.grok.imported, true)
  const entry = readStore(root).grok
  assert.equal(entry.accessToken, undefined)
  assert.deepEqual(Object.keys(entry.accounts), ['a@example.test'])
  assert.equal(entry.accounts['a@example.test'].accessToken, 'cli-new')
})

await test('a newer token inside a hybrid entry is not rolled back by an older CLI token', async () => {
  const root = sandbox()
  grokCli(root)
  const fresh = grokSession(9, 1900000000000)
  seedStore(root, { ...fresh, accounts: { 'a@example.test': grokSession(1, 1700000000000) } })
  const report = await importCliCredentials({ home: root })
  assert.equal(report.grok.imported, false)
  assert.equal(report.grok.reason, 'plugin_token_newer')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
