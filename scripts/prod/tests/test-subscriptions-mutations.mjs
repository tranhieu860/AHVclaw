// Execute targeted mutations against the full exported plugin, with isolated homes.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = resolve(process.argv[2] ?? '')
assert.ok(process.argv[2], 'usage: node test-subscriptions-mutations.mjs <patched plugin dir>')
const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'subs-mutations-'))
const source = readFileSync(join(plugin, 'lib/index.js'), 'utf8')
const change = (text, old, replacement) => {
  assert.equal(text.split(old).length - 1, 1, `mutation anchor must occur exactly once: ${old}`)
  return text.replace(old, replacement)
}
const builder = name => text => {
  const start = text.indexOf(`function ${name}(`)
  assert.ok(start !== -1)
  const end = text.indexOf('\n/**', start)
  const part = change(text.slice(start, end), '\t\t...refreshTokenExpiry(tokens),\n', '')
  return text.slice(0, start) + part + text.slice(end)
}
const mutants = [
  ['drop-known-expiry', 'successful refresh preserves known', text => change(text, '\t\t\t...refreshed.refreshTokenExpiresAt === void 0 && attempted.refreshTokenExpiresAt !== void 0 ? { refreshTokenExpiresAt: attempted.refreshTokenExpiresAt } : {}\n', '')],
  ['drop-codex-wire-expiry', 'OAuth login records', builder('codexSession')],
  ['drop-claude-wire-expiry', 'claude: issuer refresh lifetime', builder('claudeSession')],
  ['drop-grok-wire-expiry', 'grok: issuer refresh lifetime', builder('grokSession')],
  ['drop-antigravity-wire-expiry', 'antigravity: issuer refresh lifetime', builder('sessionFromTokens')],
  ['invent-unknown-expiry', 'without an issuer refresh lifetime', text => change(text, 'const seconds = tokens.refresh_token_expires_in;', 'const seconds = tokens.refresh_token_expires_in ?? 2592000;')],
  ['persist-overflow-expiry', 'unusable issuer', text => change(text, 'return Number.isFinite(expiresAt) ? { refreshTokenExpiresAt: expiresAt } : {};', 'return { refreshTokenExpiresAt: expiresAt };')],
  ['drop-cli-import-expiry', 'Claude CLI login preserves', text => change(text, '\t\t...typeof data.refreshTokenExpiresAt === "number" && Number.isFinite(data.refreshTokenExpiresAt) ? { refreshTokenExpiresAt: data.refreshTokenExpiresAt } : {},\n', '')],
  ['drop-cli-writeback-expiry', 'bound Claude refresh', text => change(text, '\tif (next.refreshTokenExpiresAt !== void 0) target.refreshTokenExpiresAt = next.refreshTokenExpiresAt;\n', '')],
  ['disable-store-lock', 'two process store mutations', text => change(text, '.then(locked, locked);', '.then(action, action);')],
  ['disable-refresh-lock', 'two processes spend', text => change(text, 'return withAuthLock(this.options.refreshLockPath, () => this.refreshLocked(session));', 'return this.refreshLocked(session);')],
  ['lock-token-snapshot', 'short access lifetime', text => change(text, 'withAuthLock(this.options.refreshLockPath, () => this.refreshLocked(session))', 'withAuthLock(`${authFilePath()}.refresh-${tokenHash(session.refreshToken)}.lock`, () => this.refreshLocked(session))')],
  ['drop-refresh-cas', 'cannot restore the account', text => change(text, '\t\tif (expected !== void 0 && (previous === void 0 || previous.accessToken !== expected.accessToken || previous.refreshToken !== expected.refreshToken)) return previous;\n', '')],
  ['ignore-access-token-cas', 'same refresh token supersedes', text => change(text, 'previous.accessToken !== expected.accessToken || ', '')],
  ['drop-migration-lock', 'legacy migration cannot', text => change(text, '\t\tif (!locked) return serialize(path, () => loadStore(path, true));\n', '')],
  ['reuse-token-after-logout', 'stops stale access-token', text => change(text, '\t\t\tif (stored === void 0) throw new LlmError(`${this.options.displayName} was logged out during refresh`, "MISSING_CREDENTIAL", { cause: error });\n', '')],
]
let killed = 0, survived = 0
const run = (candidate, filter) => spawnSync(process.execPath, [
  '--import', join(here, 'helpers/subscriptions-register.mjs'),
  join(here, 'test-subscriptions-keep-session.mjs'), '--plugin', candidate,
], {
  env: { PATH: process.env.PATH, HOME: root, DSH_HOME: join(root, '.dsh'), ...(filter ? { SUBSCRIPTIONS_TEST_FILTER: filter } : {}) },
  encoding: 'utf8', timeout: 45000,
})
try {
  const baseline = run(plugin)
  assert.equal(baseline.status, 0, `unmutated plugin must pass first: ${baseline.stdout}\n${baseline.stderr}`)
  console.log('BASELINE passed')
  for (const [name, filter, mutate] of mutants) {
    const candidate = join(root, name)
    cpSync(plugin, candidate, { recursive: true })
    writeFileSync(join(candidate, 'lib/index.js'), mutate(source))
    const result = run(candidate, filter)
    if (result.error || result.signal) throw result.error ?? new Error(`${name} terminated with ${result.signal}`)
    if (result.status === 1 && /  FAIL  /.test(result.stdout)) {
      console.log(`KILLED ${name}`)
      killed++
    } else if (result.status === 0) {
      console.log(`SURVIVED ${name}`)
      survived++
    } else throw new Error(`${name} failed without a behavioral assertion: ${result.stdout}\n${result.stderr}`)
  }
  console.log(`${killed} killed, ${survived} survived, ${mutants.length} executed`)
  process.exitCode = survived ? 1 : 0
} finally { rmSync(root, { recursive: true, force: true }) }
