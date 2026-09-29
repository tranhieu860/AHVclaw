// A dead Codex refresh must not delete the Codex login from the store.
//
// The fleet shares Codex accounts across machines: whichever machine refreshes
// first spends the refresh token, and every other machine then gets
// `refresh_token_reused` from auth.openai.com. dsh-plugin-subscriptions 0.9.6
// learned to read that answer (`{error:{code:...}}`), classes it permanent and
// deletes the session from ~/.dsh/plugins/subscriptions/auth.json — so the
// slower machines lost the account. patches/dsh-plugin-subscriptions.patch
// keeps the session and still answers INVALID_CREDENTIAL, so the console,
// login-sync and the account switcher know the login is dead.
//
// This drives the plugin itself, the copy the given tree actually resolves:
// the plugin's own apply() with a stand-in host, the `subscriptions-auth.usage`
// route (the web usage panel; it resolves the session through the same
// TokenManager `ahv run` does), and a stub token endpoint. Claude's
// `invalid_grant` is checked too — that path still removes. (`ahv login usage`
// refreshes in ahv-bot.mjs and never deletes; it does not load the plugin.)
//
// Usage: node test-codex-keep-session.mjs [<ahv tree>]       (default: this checkout)
//        node test-codex-keep-session.mjs --plugin <plugin dir>
// Exit 0 only when every check passes. Tokens here are fake and never printed.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function pluginDir(argv) {
  if (argv[0] === '--plugin') {
    if (!argv[1]) { console.error('usage: test-codex-keep-session.mjs [<ahv tree>] | --plugin <dir>'); process.exit(2) }
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

const home = mkdtempSync(join(tmpdir(), 'codex-keep-'))
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
process.env.DSH_HOME = join(home, '.dsh')
process.env.HOME = home
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k]
const store = join(process.env.DSH_HOME, 'plugins/subscriptions/auth.json')
mkdirSync(join(store, '..'), { recursive: true })

const DEAD = Date.now() - 3_600_000
const CODEX = 'acct-codex-keep'
const CLAUDE = 'dead@claude.test'
function seed() {
  writeFileSync(store, JSON.stringify({
    codex: {
      default: CODEX,
      accounts: {
        [CODEX]: { accessToken: 'fake-codex-at', refreshToken: 'fake-codex-rt', expiresAt: DEAD, accountId: CODEX },
      },
    },
    claude: {
      default: CLAUDE,
      accounts: {
        [CLAUDE]: { accessToken: 'fake-claude-at', refreshToken: 'fake-claude-rt', expiresAt: DEAD, emailAddress: CLAUDE },
      },
    },
  }), { mode: 0o600 })
}
const stored = () => JSON.parse(readFileSync(store, 'utf8'))

// The token endpoints answer the way they do for a spent refresh token.
const tokenCalls = { codex: 0, claude: 0 }
const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
  if (url.hostname === 'auth.openai.com' && url.pathname === '/oauth/token') {
    tokenCalls.codex++
    return answer(401, { error: { message: 'Your refresh token has already been used to generate a new access token. Please try signing in again.', type: 'invalid_request_error', param: null, code: 'refresh_token_reused' } })
  }
  if (url.pathname.endsWith('/oauth/token')) {
    tokenCalls.claude++
    return answer(400, { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' })
  }
  return answer(503, { error: 'offline test' })
}

// The smallest host apply() runs in: routes are captured, everything else inert.
const routes = new Map()
// authChanged() re-registers every adapter route: counting replace() calls is
// how the test sees the plugin's auth-changed hook run.
let authChanges = 0
const handle = () => Object.assign(() => {}, { replace: () => { authChanges++ }, dispose: () => {} })
const ctx = {
  effect: (fn) => { fn(); },
  get: () => undefined,
  logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  llm: { registerAdapter: handle, listProviders: async () => [], listModels: async () => [], resolveModelInfo: async () => undefined },
  inject(deps, cb) {
    if (!deps.includes('connection')) return
    cb({
      effect: (fn) => { fn(); },
      get: () => ({ fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } }),
    })
  },
}

const plugin = await import(pathToFileURL(join(dir, 'lib/index.js')).href)
plugin.apply(ctx, { pool: { enabled: false } })

async function usage(provider, account) {
  const route = routes.get('/api/subscriptions-auth.usage')
  assert.ok(route, 'the plugin did not register /api/subscriptions-auth.usage')
  const res = await route.fetch(new Request('http://127.0.0.1/api/subscriptions-auth.usage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'subscriptions-auth.usage', payload: { provider, account, force: true } }),
  }))
  return (await res.json()).result
}

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++ }
}

console.log(`dsh-plugin-subscriptions ${version} (${dir})`)

await check('codex refresh_token_reused keeps the account in auth.json', async () => {
  seed()
  const before = stored().codex.accounts[CODEX]
  const result = await usage('codex', CODEX)
  assert.ok(tokenCalls.codex >= 1, 'the codex token endpoint was never asked')
  assert.equal(result?.ok, false, 'usage should fail for a dead login')
  const after = stored().codex?.accounts?.[CODEX]
  assert.ok(after, `codex account "${CODEX}" was deleted from the store`)
  assert.deepEqual(after, before, 'the stored codex session changed')
  assert.equal(stored().codex.default, CODEX)
})

await check('codex dead login is still reported as INVALID_CREDENTIAL / login expired', async () => {
  seed()
  const result = await usage('codex', CODEX)
  const text = JSON.stringify(result?.error ?? result)
  assert.match(text, /INVALID_CREDENTIAL|login expired or was revoked/, `got ${text.slice(0, 200)}`)
  assert.ok(stored().codex?.accounts?.[CODEX], 'second failure deleted the account')
})

await check('codex spent refresh token is not sent again (same process)', async () => {
  seed()
  const calls = tokenCalls.codex
  const result = await usage('codex', CODEX)
  assert.match(JSON.stringify(result?.error ?? result), /INVALID_CREDENTIAL|login expired or was revoked/)
  assert.equal(tokenCalls.codex, calls, 'the dead refresh token went to auth.openai.com again')
})

await check('codex login refilled in the store (login-sync) is used and clears the pool state', async () => {
  seed()
  const store$ = stored()
  store$.codex.accounts[CODEX] = { accessToken: 'fake-codex-at-2', refreshToken: 'fake-codex-rt-2', expiresAt: Date.now() + 3_600_000, accountId: CODEX }
  writeFileSync(store, JSON.stringify(store$), { mode: 0o600 })
  const calls = tokenCalls.codex
  const changes = authChanges
  const result = await usage('codex', CODEX)
  assert.equal(tokenCalls.codex, calls, 'a live session was refreshed')
  assert.doesNotMatch(JSON.stringify(result?.error ?? result), /INVALID_CREDENTIAL|login expired or was revoked/)
  assert.ok(authChanges > changes, 'auth-changed hook did not run after the login came back')
  assert.equal(stored().codex.accounts[CODEX].refreshToken, 'fake-codex-rt-2')
})

await check('codex login refreshed elsewhere without rotating the refresh token is used', async () => {
  seed()
  await usage('codex', CODEX)
  const store$ = stored()
  store$.codex.accounts[CODEX] = { ...store$.codex.accounts[CODEX], accessToken: 'fake-codex-at-3', expiresAt: Date.now() + 3_600_000 }
  writeFileSync(store, JSON.stringify(store$), { mode: 0o600 })
  const result = await usage('codex', CODEX)
  assert.doesNotMatch(JSON.stringify(result?.error ?? result), /INVALID_CREDENTIAL|login expired or was revoked/)
})

await check('codex dead login whose access token is still valid keeps being used', async () => {
  seed()
  await usage('codex', CODEX)
  // The same dead session, but its access token has not run out yet.
  const store$ = stored()
  store$.codex.accounts[CODEX] = { ...store$.codex.accounts[CODEX], expiresAt: Date.now() + 60_000 }
  writeFileSync(store, JSON.stringify(store$), { mode: 0o600 })
  const calls = tokenCalls.codex
  const result = await usage('codex', CODEX)
  assert.equal(tokenCalls.codex, calls, 'the dead refresh token went to auth.openai.com again')
  assert.ok(stored().codex?.accounts?.[CODEX])
  assert.doesNotMatch(JSON.stringify(result?.error ?? result), /INVALID_CREDENTIAL|login expired or was revoked/, 'a still-valid access token was refused')
})

await check('claude invalid_grant still removes the claude account (unchanged)', async () => {
  seed()
  const result = await usage('claude', CLAUDE)
  assert.ok(tokenCalls.claude >= 1, 'the claude token endpoint was never asked')
  assert.equal(result?.ok, false)
  assert.equal(stored().claude?.accounts?.[CLAUDE], undefined, 'claude account kept — upstream behaviour changed')
  assert.ok(stored().codex?.accounts?.[CODEX], 'claude removal took the codex account with it')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
