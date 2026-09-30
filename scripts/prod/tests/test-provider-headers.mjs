// Provider HTTP headers match subscriptions 0.9.6 without loading the harness.
// All requests use fake tokens and an injected fetch; Claude version probes use
// executable fixtures on PATH, never an installed CLI or a provider network.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = new URL('../ahv-bot.mjs', import.meta.url)
const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const WORKSPACE = dirname(REPO)
const TEST_FILE = fileURLToPath(import.meta.url)

if (process.argv.includes('--probe-child')) {
  const marker = process.env.HEADER_PROBE_MARKER
  const probeCount = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0
  const mod = await import(BIN.href)
  const importedProbeCount = probeCount()
  const calls = []
  let name
  const fetchFn = async (url, init) => {
    calls.push({ name, url, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)), body: init.body })
    return {
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({ limits: [], access_token: 'fake-new-access', refresh_token: 'fake-new-refresh', expires_in: 3600, account: { email: 'fake@example.test' } }),
      text: async () => '',
    }
  }
  const session = { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: 0, accountId: 'fake-account', projectId: 'fake-project' }
  for (const kind of ['codex', 'grok', 'antigravity']) {
    name = `${kind} usage`
    await mod.fetchProviderUsage(kind, session, fetchFn)
  }
  name = 'codex usage without account id'
  const { accountId: _accountId, ...withoutAccountId } = session
  await mod.fetchProviderUsage('codex', withoutAccountId, fetchFn)
  const unrelatedProbeCount = probeCount()
  for (let i = 0; i < 2; i++) {
    name = 'claude usage'
    await mod.fetchProviderUsage('claude', session, fetchFn)
  }
  const refreshResults = {}
  for (const kind of ['claude', 'codex', 'grok', 'antigravity']) {
    name = `${kind} refresh`
    refreshResults[kind] = await mod.refreshSessionIfStale(kind, session, fetchFn, 1000)
  }
  const config = join(process.env.HOME, '.claude')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: session }))
  name = 'claude profile'
  await mod.importCliCredentials({ home: process.env.HOME, claudeConfigDir: config, fetchFn })
  process.stdout.write(JSON.stringify({ importedProbeCount, unrelatedProbeCount, probeCount: probeCount(), calls, refreshResults }))
  process.exit(0)
}

const temp = mkdtempSync(join(WORKSPACE, 'header-tests-'))
process.on('exit', () => rmSync(temp, { recursive: true, force: true }))

// Resolve the installed plugin when present. The approved source copies are a
// documented gate fallback for this dependency-free checkout, not an import.
function pluginProviderSource(provider, anchors = [join(REPO, 'packages/bundle/ahv/package.json'), join(REPO, 'package.json')]) {
  for (const anchor of anchors) {
    let entry
    try { entry = createRequire(anchor).resolve('dsh-plugin-subscriptions') }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
      continue
    }
    for (let dir = dirname(entry); dirname(dir) !== dir; dir = dirname(dir)) {
      const manifest = join(dir, 'package.json')
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'dsh-plugin-subscriptions') {
        const file = join(dir, 'lib/providers', `${provider}.js`)
        console.log(`  GATE  installed plugin: ${file}`)
        return readFileSync(file, 'utf8')
      }
    }
    throw new Error(`resolved subscriptions plugin has no package root: ${entry}`)
  }
  const file = join(WORKSPACE, 'inputs', `plugin096-${provider}.js`)
  console.log(`  GATE  plugin not installed; using approved fallback: ${file}`)
  return readFileSync(file, 'utf8')
}

const claudeSource = pluginProviderSource('claude')
const antigravitySource = pluginProviderSource('antigravity')
const pluginFloor = /export const CLAUDE_CLI_FALLBACK_VERSION = '([^']+)'/.exec(claudeSource)?.[1]
assert.ok(pluginFloor, 'plugin fallback version must remain readable by the drift gate')
const pluginUserAgentTemplate = /export function claudeCliUserAgent\(version\)\s*{\s*return `([^`]+)`;?\s*}/.exec(claudeSource)?.[1]
assert.ok(pluginUserAgentTemplate, 'plugin Claude UA form must remain readable by the drift gate')
const pluginClaudeUserAgent = pluginUserAgentTemplate.replace('${version}', pluginFloor)
const pluginAntigravityUserAgent = /export const ANTIGRAVITY_DEFAULT_USER_AGENT = '([^']+)'/.exec(antigravitySource)?.[1]
assert.ok(pluginAntigravityUserAgent, 'plugin Antigravity UA must remain readable by the drift gate')
const copiedFloor = /const CLAUDE_CLI_FALLBACK_VERSION = '([^']+)'/.exec(readFileSync(BIN, 'utf8'))?.[1]

const HARNESS_USER_AGENT = 'deepseek-harness/0.2.0-rc.1 (+https://github.com/deepseek-ai/deepseek-harness)'
let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`) }
  catch (error) { failed++; console.log(`  FAIL  ${name}\n        ${error.message}`) }
}

function scenario(label, output, { missing = false, hang = false } = {}) {
  const home = join(temp, label)
  const path = join(home, 'bin')
  const marker = join(home, 'probes.txt')
  mkdirSync(path, { recursive: true })
  if (!missing) {
    writeFileSync(join(path, 'claude'), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.HEADER_PROBE_MARKER, process.argv.slice(2).join(' ') + '\\n');\n${hang ? 'setInterval(() => {}, 1000);' : `process.stdout.write(${JSON.stringify(output)});`}\n`, { mode: 0o700 })
  }
  const started = Date.now()
  const child = spawnSync(process.execPath, [TEST_FILE, '--probe-child'], {
    cwd: REPO, encoding: 'utf8', timeout: 10_000,
    env: {
      PATH: path, HOME: home, DSH_HOME: join(home, '.dsh'), AHV_FORK: REPO,
      HEADER_PROBE_MARKER: marker,
      ANTIGRAVITY_CLIENT_ID: 'fake-client', ANTIGRAVITY_CLIENT_SECRET: 'fake-secret',
    },
  })
  assert.equal(child.status, 0, child.stderr || child.error?.message || child.stdout)
  return { ...JSON.parse(child.stdout), elapsed: Date.now() - started, marker }
}

const missing = scenario('missing', '', { missing: true })
const getCall = (result, name) => result.calls.find(call => call.name === name)

await check('Claude usage sends the plugin floor and UA form when CLI is absent', () => {
  const call = getCall(missing, 'claude usage')
  assert.equal(call.url, 'https://api.anthropic.com/api/oauth/usage')
  assert.deepEqual(call.headers, {
    authorization: 'Bearer fake-access', 'anthropic-beta': 'oauth-2025-04-20',
    'user-agent': pluginClaudeUserAgent, accept: 'application/json',
  })
})
await check('Codex usage sends harness attribution and account identity', () => {
  const call = getCall(missing, 'codex usage')
  assert.equal(call.url, 'https://chatgpt.com/backend-api/wham/usage')
  assert.deepEqual(call.headers, {
    authorization: 'Bearer fake-access', 'chatgpt-account-id': 'fake-account',
    originator: 'codex_cli_rs', accept: 'application/json', 'user-agent': HARNESS_USER_AGENT,
  })
})
await check('Codex usage preserves the plugin account header even when accountId is absent', () => {
  const call = getCall(missing, 'codex usage without account id')
  assert.deepEqual(call.headers, {
    authorization: 'Bearer fake-access', 'chatgpt-account-id': 'undefined',
    originator: 'codex_cli_rs', accept: 'application/json', 'user-agent': HARNESS_USER_AGENT,
  })
})
await check('Grok billing sends harness attribution and its CLI auth header', () => {
  const call = getCall(missing, 'grok usage')
  assert.equal(call.url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits')
  assert.deepEqual(call.headers, {
    authorization: 'Bearer fake-access', 'x-xai-token-auth': 'xai-grok-cli',
    accept: 'application/json', 'user-agent': HARNESS_USER_AGENT,
  })
})
await check('Antigravity usage sends exactly the plugin internal API headers', () => {
  const call = getCall(missing, 'antigravity usage')
  assert.equal(call.url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary')
  assert.equal(call.method, 'POST')
  assert.equal(call.body, '{"project":"fake-project"}')
  assert.deepEqual(call.headers, {
    authorization: 'Bearer fake-access', 'content-type': 'application/json', 'user-agent': pluginAntigravityUserAgent,
  })
})
await check('Claude refresh keeps exactly the plugin JSON token header', () => {
  const call = getCall(missing, 'claude refresh')
  assert.equal(call.url, 'https://claude.ai/v1/oauth/token')
  assert.equal(call.method, 'POST')
  assert.deepEqual(call.headers, { 'content-type': 'application/json' })
})
await check('Antigravity refresh keeps exactly the plugin form token header', () => {
  const call = getCall(missing, 'antigravity refresh')
  assert.equal(call.url, 'https://oauth2.googleapis.com/token')
  assert.equal(call.method, 'POST')
  assert.deepEqual(call.headers, { 'content-type': 'application/x-www-form-urlencoded' })
})
await check('Codex and Grok remain unsupported for refresh with no added requests', () => {
  for (const kind of ['codex', 'grok']) {
    assert.equal(getCall(missing, `${kind} refresh`), undefined)
    assert.equal(missing.refreshResults[kind].refreshed, false)
  }
  assert.equal(missing.calls.length, 9, 'six usage calls, two refresh calls and one profile call')
})
await check('Claude imported account profile sends exactly plugin authorization', () => {
  const call = getCall(missing, 'claude profile')
  assert.equal(call.url, 'https://api.anthropic.com/api/oauth/profile')
  assert.deepEqual(call.headers, { authorization: 'Bearer fake-access' })
})

for (const [label, output, expected] of [
  ['installed', '2.1.283 (Claude Code)\n', '2.1.283'],
  ['older', 'Claude Code version 2.1.9\n', '2.1.283'],
  ['newer', 'Claude Code version 2.1.285\n', '2.1.285'],
  ['major', '12.0.1 (Claude Code)\n', '12.0.1'],
  ['malformed', 'Claude Code unknown version\n', '2.1.283'],
]) {
  await check(`Claude ${label} version uses ${expected} and probes at most once`, () => {
    const result = scenario(label, output)
    assert.equal(result.importedProbeCount, 0, 'module import must not probe Claude')
    assert.equal(result.unrelatedProbeCount, 0, 'other providers must not probe Claude')
    assert.equal(result.probeCount, 1, 'two usage reads in one process must share one probe')
    assert.equal(readFileSync(result.marker, 'utf8'), '--version\n')
    for (const call of result.calls.filter(call => call.name === 'claude usage')) {
      assert.equal(call.headers['user-agent'], `claude-cli/${expected} (external, cli)`)
    }
  })
}
await check('a hung Claude version probe falls back within a short timeout and is memoized', () => {
  const result = scenario('timeout', '', { hang: true })
  assert.ok(result.elapsed < 5000, `version probe took ${result.elapsed}ms`)
  assert.equal(result.probeCount, 1)
  assert.equal(getCall(result, 'claude usage').headers['user-agent'], pluginClaudeUserAgent)
})

function assertPluginGate(claude, antigravity) {
  const floor = /export const CLAUDE_CLI_FALLBACK_VERSION = '([^']+)'/.exec(claude)?.[1]
  assert.equal(copiedFloor, floor, 'copied Claude fallback differs from plugin')
  const template = /export function claudeCliUserAgent\(version\)\s*{\s*return `([^`]+)`;?\s*}/.exec(claude)?.[1]
  assert.equal(getCall(missing, 'claude usage').headers['user-agent'], template?.replace('${version}', floor), 'Claude UA form differs from plugin')
  const antigravityUa = /export const ANTIGRAVITY_DEFAULT_USER_AGENT = '([^']+)'/.exec(antigravity)?.[1]
  assert.equal(getCall(missing, 'antigravity usage').headers['user-agent'], antigravityUa, 'Antigravity UA differs from plugin')
}
await check('copied Claude floor and both UA forms match resolved plugin sources', () => {
  assertPluginGate(claudeSource, antigravitySource)
})
await check('installed plugin resolution governs the gate and catches all three source drifts', () => {
  const fixture = join(temp, 'installed-gate')
  const packageDir = join(fixture, 'node_modules/dsh-plugin-subscriptions')
  const providers = join(packageDir, 'lib/providers')
  mkdirSync(providers, { recursive: true })
  writeFileSync(join(fixture, 'package.json'), '{"name":"header-gate-fixture"}')
  writeFileSync(join(packageDir, 'package.json'), '{"name":"dsh-plugin-subscriptions","version":"0.9.6","main":"index.js"}')
  writeFileSync(join(packageDir, 'index.js'), '// resolution fixture only\n')
  const claudeFile = join(providers, 'claude.js')
  const antigravityFile = join(providers, 'antigravity.js')
  const anchors = [join(fixture, 'package.json')]
  writeFileSync(claudeFile, claudeSource)
  writeFileSync(antigravityFile, antigravitySource)
  const installedClaude = () => pluginProviderSource('claude', anchors)
  const installedAntigravity = () => pluginProviderSource('antigravity', anchors)
  assertPluginGate(installedClaude(), installedAntigravity())
  writeFileSync(claudeFile, claudeSource.replace(`CLAUDE_CLI_FALLBACK_VERSION = '${pluginFloor}'`, "CLAUDE_CLI_FALLBACK_VERSION = '99.0.0'"))
  assert.throws(() => assertPluginGate(installedClaude(), installedAntigravity()), /copied Claude fallback differs/)
  writeFileSync(claudeFile, claudeSource.replace('claude-cli/${version} (external, cli)', 'changed-cli/${version} (external, cli)'))
  assert.throws(() => assertPluginGate(installedClaude(), installedAntigravity()), /Claude UA form differs/)
  writeFileSync(claudeFile, claudeSource)
  writeFileSync(antigravityFile, antigravitySource.replace(pluginAntigravityUserAgent, 'antigravity/99.0.0 changed-plugin'))
  assert.throws(() => assertPluginGate(installedClaude(), installedAntigravity()), /Antigravity UA differs/)
})
await check('an installed plugin with unsupported root exports fails the gate instead of using fallback', () => {
  const fixture = join(temp, 'installed-import-only')
  const packageDir = join(fixture, 'node_modules/dsh-plugin-subscriptions')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(fixture, 'package.json'), '{"name":"header-gate-import-only-fixture"}')
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-subscriptions', version: '0.9.6', exports: { '.': { import: './index.js' } },
  }))
  writeFileSync(join(packageDir, 'index.js'), '// import-only resolution fixture\n')
  assert.throws(() => pluginProviderSource('claude', [join(fixture, 'package.json')]), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
