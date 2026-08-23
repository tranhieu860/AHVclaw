// Claude must be importable like the other two.
//
// The subscriptions plugin exposes a provider only once its own store holds a
// session. For Claude it never runs an OAuth flow — it copies whatever the
// `claude` CLI stored — so a bot user that never ran `claude` had no Claude
// provider at all, while requests naming a Claude model still answered by
// falling through to the router.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const mod = await import('/home/claudeproxy/Claude/AHVclaw-fork/scripts/prod/ahv-bot.mjs')
const { importCliCredentials } = mod

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (error) { console.log(`  FAIL  ${name}\n        ${error.message}`); failed++ }
}
function makeHome() { return mkdtempSync(join(tmpdir(), 'ahvhome-')) }
function writeClaude(home, oauth, dir = '.claude') {
  const d = join(home, dir)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
  return d
}
const future = Date.now() + 3600_000

check('a Claude CLI login is imported into the store', () => {
  const home = makeHome()
  writeClaude(home, { accessToken: 'a1', refreshToken: 'r1', expiresAt: future, scopes: ['user:inference'] })
  const report = importCliCredentials({ home })
  assert.equal(report.claude?.imported, true, JSON.stringify(report.claude))
  const store = JSON.parse(readFileSync(join(home, '.dsh/plugins/subscriptions/auth.json'), 'utf8'))
  assert.equal(store.claude.accessToken, 'a1')
  assert.equal(store.claude.refreshToken, 'r1')
  assert.equal(store.claude.expiresAt, future)
})

check('CLAUDE_CONFIG_DIR redirects where the login is read from', () => {
  const home = makeHome()
  const shared = mkdtempSync(join(tmpdir(), 'shared-'))
  writeFileSync(join(shared, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'shared', refreshToken: 'rs', expiresAt: future } }))
  const report = importCliCredentials({ home, claudeConfigDir: shared })
  assert.equal(report.claude?.imported, true, JSON.stringify(report.claude))
  const store = JSON.parse(readFileSync(join(home, '.dsh/plugins/subscriptions/auth.json'), 'utf8'))
  assert.equal(store.claude.accessToken, 'shared')
})

check('a missing Claude login reports why, and imports nothing', () => {
  const home = makeHome()
  const report = importCliCredentials({ home })
  assert.equal(report.claude?.imported, false)
  assert.equal(report.claude?.reason, 'cli_not_logged_in')
  assert.equal(existsSync(join(home, '.dsh/plugins/subscriptions/auth.json')), false)
})

check('a corrupt credentials file is reported, not thrown', () => {
  const home = makeHome()
  const d = join(home, '.claude'); mkdirSync(d, { recursive: true })
  writeFileSync(join(d, '.credentials.json'), '{not json')
  const report = importCliCredentials({ home })
  assert.equal(report.claude?.reason, 'cli_unreadable')
})

check('a login without the tokens is not imported', () => {
  const home = makeHome()
  writeClaude(home, { expiresAt: future })
  const report = importCliCredentials({ home })
  assert.equal(report.claude?.imported, false)
  assert.equal(report.claude?.reason, 'cli_not_logged_in')
})

check('a newer token already in the store is left alone', () => {
  const home = makeHome()
  writeClaude(home, { accessToken: 'old', refreshToken: 'r', expiresAt: future })
  const dir = join(home, '.dsh/plugins/subscriptions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    claude: { accessToken: 'newer', refreshToken: 'r2', expiresAt: future + 60_000 },
  }))
  const report = importCliCredentials({ home })
  assert.equal(report.claude?.reason, 'plugin_token_newer')
  const store = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))
  assert.equal(store.claude.accessToken, 'newer')
})

check('a bare credentials blob without the wrapper key still works', () => {
  const home = makeHome()
  const d = join(home, '.claude'); mkdirSync(d, { recursive: true })
  writeFileSync(join(d, '.credentials.json'),
    JSON.stringify({ accessToken: 'bare', refreshToken: 'rb', expiresAt: future }))
  const report = importCliCredentials({ home })
  assert.equal(report.claude?.imported, true, JSON.stringify(report.claude))
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
