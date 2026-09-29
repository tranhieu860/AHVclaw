// A failed refresh must not delete any login from the AHV subscriptions store.
//
// ~/.dsh/plugins/subscriptions/auth.json is the host's master copy of its
// logins. dsh-plugin-subscriptions deletes a session whenever a refresh fails
// "permanently" — and on the fleet that happens to logins that are still
// wanted: an account shared across hosts gets its refresh token spent by
// whichever host refreshed first (Codex `refresh_token_reused`), and a login
// login-sync copies from a CLI can carry a token the provider already rotated
// (#7, 29/09: Claude `invalid_grant`, deleted by `ahv models list` on every
// core, refilled by login-sync 15 minutes later). patches/
// dsh-plugin-subscriptions.patch keeps every provider's session, still answers
// INVALID_CREDENTIAL (so the console, login-sync and the account switcher see a
// dead login), stops re-sending a dead token, and makes every store write carry
// the entries the store reader skips. Only a user logout removes a login.
//
// This drives the plugin itself, the copy the given tree actually resolves:
// the plugin's own apply() with a stand-in host, the `subscriptions-auth.*`
// routes (usage panel, logout, default account), each provider's model listing
// (what `ahv models list` and `ahv run` resolve through), and stub token
// endpoints answering the way the real ones do for a dead refresh token.
//
// The tree must be built: the plugin imports workspace vendor packages from lib/.
// Usage: node test-subscriptions-keep-session.mjs [<ahv tree>]   (default: this checkout)
//        node test-subscriptions-keep-session.mjs --plugin <plugin dir>
// Exit 0 only when every check passes. Tokens here are fake and never printed.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function pluginDir(argv) {
  if (argv[0] === '--plugin') {
    if (!argv[1]) { console.error('usage: test-subscriptions-keep-session.mjs [<ahv tree>] | --plugin <dir>'); process.exit(2) }
    return resolve(argv[1])
  }
  const tree = resolve(argv[0] ?? new URL('../../..', import.meta.url).pathname)
  // apps/cli depends on the AHV bundle, and the bundle on the plugin: resolving
  // from the bundle is the copy `ahv run`, `ahv login` and `ahv web` load.
  const req = createRequire(join(tree, 'packages/bundle/ahv/package.json'))
  return resolve(req.resolve('dsh-plugin-subscriptions/package.json'), '..')
}

const dir = pluginDir(process.argv.slice(2))
const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version

const home = mkdtempSync(join(tmpdir(), 'subs-keep-'))
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
process.env.DSH_HOME = join(home, '.dsh')
process.env.HOME = home
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'CLAUDE_CONFIG_DIR']) delete process.env[k]
const store = join(process.env.DSH_HOME, 'plugins/subscriptions/auth.json')
mkdirSync(join(store, '..'), { recursive: true })

const DEAD = Date.now() - 3_600_000
// One dead login per provider, keyed the way the plugin keys it.
const KEY = {
  codex: 'acct-codex-keep',
  claude: 'dead@claude.test',
  grok: 'dead@grok.test',
  antigravity: 'dead@antigravity.test',
  copilot: 'dead-copilot',
}
const PROVIDERS = Object.keys(KEY)
function session(provider, n = 1, expiresAt = DEAD) {
  const base = { accessToken: `fake-${provider}-at-${n}`, refreshToken: `fake-${provider}-rt-${n}`, expiresAt }
  switch (provider) {
    case 'codex': return { ...base, accountId: KEY.codex }
    case 'claude': return { ...base, emailAddress: KEY.claude }
    case 'grok': return { ...base, account: KEY.grok, tokenEndpoint: 'https://auth.x.ai/oauth2/token' }
    case 'antigravity': return { ...base, account: KEY.antigravity, projectId: 'fake-project' }
    case 'copilot': return { ...base, account: KEY.copilot }
  }
}
function seed(extra = {}) {
  const data = {}
  for (const p of PROVIDERS) data[p] = { default: KEY[p], accounts: { [KEY[p]]: session(p) } }
  writeFileSync(store, JSON.stringify({ ...data, ...extra }), { mode: 0o600 })
}
const stored = () => JSON.parse(readFileSync(store, 'utf8'))
function put(provider, value) {
  const data = stored()
  data[provider].accounts[KEY[provider]] = value
  writeFileSync(store, JSON.stringify(data), { mode: 0o600 })
}

// Token endpoints answer the way they did for a dead refresh token; the Claude
// body is the one claude.ai sent #7 on 29/09.
let codexCode = 'refresh_token_reused'
const tokenCalls = Object.fromEntries(PROVIDERS.map(p => [p, 0]))
const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
  const at = `${url.hostname}${url.pathname}`
  if (at === 'auth.openai.com/oauth/token') {
    tokenCalls.codex++
    return answer(401, { error: { message: 'Invalid refresh token.', type: 'invalid_request_error', param: null, code: codexCode } })
  }
  if (at === 'claude.ai/v1/oauth/token' || at.endsWith('/oauth/token')) {
    tokenCalls.claude++
    return answer(400, { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' })
  }
  if (at === 'auth.x.ai/oauth2/token') {
    tokenCalls.grok++
    return answer(400, { error: 'invalid_grant', error_description: 'refresh token revoked' })
  }
  if (at === 'oauth2.googleapis.com/token') {
    tokenCalls.antigravity++
    return answer(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
  }
  if (at === 'api.github.com/copilot_internal/v2/token') {
    tokenCalls.copilot++
    return answer(401, { message: 'Bad credentials' })
  }
  return answer(503, { error: 'offline test' })
}

// The smallest host apply() runs in: routes and adapters are captured.
const routes = new Map()
const adapters = new Map()
// authChanged() re-registers every adapter route: counting replace() calls is
// how the test sees the plugin's auth-changed hook run.
let authChanges = 0
const handle = () => Object.assign(() => {}, { replace: () => { authChanges++ }, dispose: () => {} })
const ctx = {
  effect: (fn) => { fn(); },
  get: () => undefined,
  logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  llm: {
    registerAdapter: (ids, route) => { for (const id of ids) adapters.set(id, route); return handle() },
    listProviders: async () => [], listModels: async () => [], resolveModelInfo: async () => undefined,
  },
  inject(deps, cb) {
    if (!deps.includes('connection')) return
    cb({
      effect: (fn) => { fn(); },
      get: () => ({ fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }),
    })
  },
}

const plugin = await import(pathToFileURL(join(dir, 'lib/index.js')).href)
// The pool's usage cache would answer repeat usage calls without asking the
// TokenManager; direct routes resolve every call.
plugin.apply(ctx, { pool: { enabled: false } })

async function rpc(method, payload) {
  const path = `/api/subscriptions-auth.${method}`
  const route = routes.get(path)
  assert.ok(route, `the plugin did not register ${path}`)
  const res = await route.fetch(new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: `subscriptions-auth.${method}`, payload }),
  }))
  return (await res.json()).result
}
const usage = (provider) => rpc('usage', { provider, account: KEY[provider], force: true })
async function listModels(provider) {
  const adapter = adapters.get(provider)
  assert.ok(adapter, `no ${provider} adapter registered`)
  return adapter.listModels(provider)
}
const DEAD_TEXT = /INVALID_CREDENTIAL|login expired or was revoked/
// A model request as `ahv run` makes it; resolves to the error it fails with.
async function generate(provider) {
  try {
    for await (const event of adapters.get(provider).options.adapter.stream({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, { signal: new AbortController().signal })) void event
  } catch (error) {
    return error
  }
  return undefined
}

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++ }
}

console.log(`dsh-plugin-subscriptions ${version} (${dir})`)

// Every provider, through the path `ahv models list` / `ahv run` take.
for (const provider of PROVIDERS) {
  await check(`${provider}: dead refresh during model listing keeps the account`, async () => {
    seed()
    const before = stored()[provider].accounts[KEY[provider]]
    const calls = tokenCalls[provider]
    await listModels(provider)
    assert.ok(tokenCalls[provider] > calls, `the ${provider} token endpoint was never asked`)
    assert.deepEqual(stored()[provider]?.accounts?.[KEY[provider]], before, `${provider} account was deleted or changed`)
    for (const other of PROVIDERS) assert.ok(stored()[other]?.accounts?.[KEY[other]], `${other} account lost along the way`)
  })
}

// The error a model request fails with is what the pool and the agent loop act on.
for (const provider of PROVIDERS) {
  await check(`${provider}: model request on a dead login fails with INVALID_CREDENTIAL, token sent once`, async () => {
    seed()
    put(provider, session(provider, 7))
    const calls = tokenCalls[provider]
    for (const attempt of ['first', 'repeat']) {
      const error = await generate(provider)
      assert.equal(error?.code, 'INVALID_CREDENTIAL', `${attempt} failure: ${error?.name} ${error?.code}`)
    }
    assert.equal(tokenCalls[provider], calls + 1, `the ${provider} token endpoint was asked ${tokenCalls[provider] - calls} times`)
    assert.ok(stored()[provider]?.accounts?.[KEY[provider]], `${provider} account was deleted`)
  })
}

// Providers with a usage route: the dead login still reads as dead.
for (const provider of PROVIDERS.filter(p => p !== 'copilot')) {
  await check(`${provider}: usage panel reports the dead login and the token is not sent again`, async () => {
    seed()
    put(provider, session(provider, 8))
    const calls = tokenCalls[provider]
    for (const attempt of ['first', 'repeat']) {
      const result = await usage(provider)
      assert.equal(result?.ok, false, `${attempt}: usage should fail for a dead login`)
      assert.match(JSON.stringify(result?.error ?? result), DEAD_TEXT, attempt)
    }
    assert.equal(tokenCalls[provider], calls + 1, `the ${provider} token endpoint was asked ${tokenCalls[provider] - calls} times`)
    assert.ok(stored()[provider]?.accounts?.[KEY[provider]], `${provider} account was deleted`)
  })
}

await check('codex invalid_refresh_token counts as dead (reported, not retried)', async () => {
  codexCode = 'invalid_refresh_token'
  try {
    seed()
    put('codex', session('codex', 5))
    const calls = tokenCalls.codex
    const first = await usage('codex')
    assert.match(JSON.stringify(first?.error ?? first), DEAD_TEXT)
    const second = await usage('codex')
    assert.match(JSON.stringify(second?.error ?? second), DEAD_TEXT)
    assert.equal(tokenCalls.codex, calls + 1, 'invalid_refresh_token was retried or never sent')
    assert.ok(stored().codex?.accounts?.[KEY.codex])
  } finally { codexCode = 'refresh_token_reused' }
})

for (const provider of ['codex', 'claude']) {
  await check(`${provider}: login refilled in the store (login-sync) is used and clears the pool state`, async () => {
    seed()
    await usage(provider)
    put(provider, session(provider, 2, Date.now() + 3_600_000))
    const calls = tokenCalls[provider]
    const changes = authChanges
    const result = await usage(provider)
    assert.equal(tokenCalls[provider], calls, 'a live session was refreshed')
    assert.doesNotMatch(JSON.stringify(result?.error ?? result), DEAD_TEXT)
    assert.ok(authChanges > changes, 'auth-changed hook did not run after the login came back')
    assert.equal(stored()[provider].accounts[KEY[provider]].refreshToken, `fake-${provider}-rt-2`)
  })
}

await check('codex login refreshed elsewhere without rotating the refresh token is used', async () => {
  seed()
  await usage('codex')
  put('codex', { ...stored().codex.accounts[KEY.codex], accessToken: 'fake-codex-at-3', expiresAt: Date.now() + 3_600_000 })
  const changes = authChanges
  const result = await usage('codex')
  assert.doesNotMatch(JSON.stringify(result?.error ?? result), DEAD_TEXT)
  assert.ok(authChanges > changes, 'auth-changed hook did not run after the access token changed')
})

await check('codex dead login whose access token is still valid keeps being used', async () => {
  seed()
  await usage('codex')
  // The same dead session, but its access token has not run out yet.
  put('codex', { ...stored().codex.accounts[KEY.codex], expiresAt: Date.now() + 60_000 })
  const calls = tokenCalls.codex
  const result = await usage('codex')
  assert.equal(tokenCalls.codex, calls, 'the dead refresh token went to auth.openai.com again')
  assert.ok(stored().codex?.accounts?.[KEY.codex])
  assert.doesNotMatch(JSON.stringify(result?.error ?? result), DEAD_TEXT, 'a still-valid access token was refused')
})

await check('claude refresh that fails permanently while the access token is still valid keeps using it', async () => {
  seed()
  // A session this process has not seen die, inside the refresh window.
  put('claude', session('claude', 4, Date.now() + 60_000))
  const calls = tokenCalls.claude
  const result = await usage('claude')
  assert.equal(tokenCalls.claude, calls + 1, 'the refresh inside the window was not attempted')
  assert.doesNotMatch(JSON.stringify(result?.error ?? result), DEAD_TEXT, 'a still-valid access token was refused on the first failure')
  assert.ok(stored().claude?.accounts?.[KEY.claude])
})

// Store entries the plugin cannot use survive every write.
const UNUSABLE = { accessToken: '', refreshToken: 'fake-claude-rt-9', expiresAt: DEAD, emailAddress: 'broken@claude.test' }
const FOREIGN = { default: 'x', accounts: { x: { accessToken: 'fake-future-at', refreshToken: 'fake-future-rt', expiresAt: DEAD } } }
const TORN = { accounts: [] }
function seedOdd() {
  seed({ futureai: FOREIGN, grok: TORN })
  const data = stored()
  data.claude.accounts['broken@claude.test'] = UNUSABLE
  writeFileSync(store, JSON.stringify(data), { mode: 0o600 })
}

await check('a store write keeps accounts without tokens, unknown providers and unreadable entries', async () => {
  seedOdd()
  const result = await rpc('setDefault', { provider: 'codex', account: KEY.codex })
  assert.equal(result?.ok, true, `setDefault failed: ${JSON.stringify(result).slice(0, 200)}`)
  const data = stored()
  assert.deepEqual(data.claude?.accounts?.['broken@claude.test'], UNUSABLE, 'the claude account without tokens was dropped')
  assert.ok(data.claude?.accounts?.[KEY.claude], 'the usable claude account was dropped')
  assert.deepEqual(data.futureai, FOREIGN, 'the unknown provider was dropped')
  assert.deepEqual(data.grok, TORN, 'the unreadable grok entry was dropped')
})

await check('an entry whose default is not a string survives a write untouched', async () => {
  seed()
  const data = stored()
  const odd = { ...data.claude, default: 5 }
  data.claude = odd
  writeFileSync(store, JSON.stringify(data), { mode: 0o600 })
  const result = await rpc('setDefault', { provider: 'codex', account: KEY.codex })
  assert.equal(result?.ok, true, `setDefault failed: ${JSON.stringify(result).slice(0, 200)}`)
  assert.deepEqual(stored().claude, odd, 'the claude entry with an odd default was dropped or rewritten')
})

await check('a new login replaces an unreadable entry of its provider instead of losing to it', async () => {
  seed({ claude: TORN })
  // The Claude "keychain" login copies what the claude CLI stored.
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-claude-at-new', refreshToken: 'fake-claude-rt-new', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'] } }), { mode: 0o600 })
  try {
    const result = await rpc('login', { provider: 'claude', method: 'keychain' })
    assert.equal(result?.ok, true, `login failed: ${JSON.stringify(result).slice(0, 200)}`)
    const claude = stored().claude
    assert.ok(claude?.accounts && !Array.isArray(claude.accounts), `the unreadable entry won: ${JSON.stringify(claude).slice(0, 80)}`)
    assert.ok(Object.values(claude.accounts).some(account => account.refreshToken === 'fake-claude-rt-new'), 'the new login is missing')
  } finally {
    rmSync(join(home, '.claude'), { recursive: true, force: true })
  }
})

await check('a new login keeps the accounts of an entry this build could not read', async () => {
  seed()
  const data = stored()
  const odd = { default: null, accounts: { [KEY.claude]: session('claude', 11) } }
  data.claude = odd
  writeFileSync(store, JSON.stringify(data), { mode: 0o600 })
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-claude-at-12', refreshToken: 'fake-claude-rt-12', expiresAt: Date.now() + 3_600_000 } }), { mode: 0o600 })
  try {
    const result = await rpc('login', { provider: 'claude', method: 'keychain' })
    assert.equal(result?.ok, true, `login failed: ${JSON.stringify(result).slice(0, 200)}`)
    const accounts = Object.values(stored().claude?.accounts ?? {})
    assert.ok(accounts.some(account => account.refreshToken === 'fake-claude-rt-11'), 'the account of the unreadable entry was lost')
    assert.ok(accounts.some(account => account.refreshToken === 'fake-claude-rt-12'), 'the new login is missing')
  } finally {
    rmSync(join(home, '.claude'), { recursive: true, force: true })
  }
})

await check('user logout still removes exactly that account', async () => {
  seedOdd()
  const result = await rpc('logout', { provider: 'claude', account: KEY.claude })
  assert.equal(result?.ok, true, `logout failed: ${JSON.stringify(result).slice(0, 200)}`)
  const data = stored()
  assert.equal(data.claude?.accounts?.[KEY.claude], undefined, 'logout left the account in the store')
  assert.deepEqual(data.claude?.accounts?.['broken@claude.test'], UNUSABLE, 'logout took the unusable account too')
  assert.ok(data.codex?.accounts?.[KEY.codex], 'logout took another provider with it')
  assert.deepEqual(data.futureai, FOREIGN)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
