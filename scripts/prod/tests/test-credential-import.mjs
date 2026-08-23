#!/usr/bin/env node
// Tests for CLI-native credential import into the subscriptions plugin store.
// Run: node ~/.ahv/tests/test-credential-import.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { importCliCredentials, decodeJwtExpiry } = await import(
  join(process.env.HOME, '.ahv', 'bin', 'ahv-bot.mjs')
)

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
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

test('reads exp from a JWT payload', () => {
  assert.equal(decodeJwtExpiry(jwt(1800000000)), 1800000000 * 1000)
})

test('returns null for a malformed token', () => {
  assert.equal(decodeJwtExpiry('not-a-jwt'), null)
  assert.equal(decodeJwtExpiry(''), null)
  assert.equal(decodeJwtExpiry(undefined), null)
})

console.log('importCliCredentials')

test('imports codex tokens into plugin shape', () => {
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

  const report = importCliCredentials({ home: root })

  assert.equal(report.codex.imported, true)
  const store = readStore(root)
  assert.equal(store.codex.refreshToken, 'refresh-abc')
  assert.equal(store.codex.accountId, 'acct-123')
  assert.equal(store.codex.expiresAt, exp * 1000)
})

test('imports grok tokens into plugin shape', () => {
  const root = sandbox()
  writeFileSync(join(root, '.grok', 'auth.json'), JSON.stringify({
    access_token: 'grok-access',
    refresh_token: 'grok-refresh',
    expires_at: 1800000000000,
    email: 'user@example.com',
  }))

  const report = importCliCredentials({ home: root })

  assert.equal(report.grok.imported, true)
  const store = readStore(root)
  assert.equal(store.grok.accessToken, 'grok-access')
  assert.equal(store.grok.refreshToken, 'grok-refresh')
  assert.equal(store.grok.expiresAt, 1800000000000)
})

test('keeps a newer plugin token over an older CLI token', () => {
  const root = sandbox()
  const older = Math.floor(Date.now() / 1000) + 60
  writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({
    tokens: { access_token: jwt(older), refresh_token: 'old', account_id: 'a' },
  }))
  writeFileSync(storePath(root), JSON.stringify({
    codex: { accessToken: 'newer', refreshToken: 'newer', expiresAt: Date.now() + 7200_000 },
  }))

  const report = importCliCredentials({ home: root })

  assert.equal(report.codex.imported, false)
  assert.equal(report.codex.reason, 'plugin_token_newer')
  assert.equal(readStore(root).codex.accessToken, 'newer')
})

test('reports absent CLI credentials without writing a store', () => {
  const root = sandbox()

  const report = importCliCredentials({ home: root })

  assert.equal(report.codex.imported, false)
  assert.equal(report.codex.reason, 'cli_not_logged_in')
  assert.equal(report.grok.imported, false)
  assert.equal(existsSync(storePath(root)), false)
})

test('leaves other providers untouched', () => {
  const root = sandbox()
  writeFileSync(join(root, '.grok', 'auth.json'), JSON.stringify({
    access_token: 'g', refresh_token: 'r', expires_at: 1800000000000,
  }))
  writeFileSync(storePath(root), JSON.stringify({
    claude: { accessToken: 'claude-token', expiresAt: 1800000000000 },
  }))

  importCliCredentials({ home: root })

  assert.equal(readStore(root).claude.accessToken, 'claude-token')
})

test('tolerates malformed CLI credential files', () => {
  const root = sandbox()
  writeFileSync(join(root, '.codex', 'auth.json'), 'not json at all')

  const report = importCliCredentials({ home: root })

  assert.equal(report.codex.imported, false)
  assert.equal(report.codex.reason, 'cli_unreadable')
})

test('skips a codex file with no usable tokens', () => {
  const root = sandbox()
  writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'apikey', tokens: {} }))

  const report = importCliCredentials({ home: root })

  assert.equal(report.codex.imported, false)
  assert.equal(report.codex.reason, 'cli_not_logged_in')
})

test('writes the store with owner-only permissions', () => {
  const root = sandbox()
  writeFileSync(join(root, '.grok', 'auth.json'), JSON.stringify({
    access_token: 'g', refresh_token: 'r', expires_at: 1800000000000,
  }))

  importCliCredentials({ home: root })

  assert.equal(statSync(storePath(root)).mode & 0o777, 0o600)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
