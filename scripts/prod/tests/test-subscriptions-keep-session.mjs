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
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import fsPromises from 'node:fs/promises'
import { fork } from 'node:child_process'
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

const workerMode = process.env.SUBSCRIPTIONS_TEST_WORKER === '1'
const home = workerMode ? process.env.SUBSCRIPTIONS_TEST_HOME : mkdtempSync(join(tmpdir(), 'subs-keep-'))
assert.ok(home, 'worker requires a fixture home')
if (!workerMode) process.on('exit', () => rmSync(home, { recursive: true, force: true }))
process.env.DSH_HOME = join(home, '.dsh')
process.env.HOME = home
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'CLAUDE_CONFIG_DIR']) delete process.env[k]
const store = join(process.env.DSH_HOME, 'plugins/subscriptions/auth.json')
mkdirSync(join(store, '..'), { recursive: true })

// Observe real file operations to order process races without timing sleeps.
const releases = new Map()
let observeRead = false
const release = name => new Promise(resolve => releases.set(name, resolve))
if (workerMode) {
  process.on('message', message => releases.get(message.release)?.())
  const readFile = fsPromises.readFile
  fsPromises.readFile = async (...args) => {
    const value = await readFile(...args)
    if (observeRead && [store, join(process.env.DSH_HOME, 'plugins/router/auth.json')].includes(String(args[0]))) {
      observeRead = false
      const wait = release('read')
      process.send({ type: 'store-read' })
      await wait
    }
    return value
  }
  const rename = fs.renameSync
  fs.renameSync = (...args) => {
    try { return rename(...args) }
    catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code) && String(args[1]).endsWith('.lock')) process.send({ type: 'lock-wait' })
      throw error
    }
  }
  syncBuiltinESMExports()
}

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
const successfulTokens = new Set()
let refreshExpirySeconds
const idToken = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: KEY.codex } })).toString('base64url')}.fake`
let responseIdToken = idToken
let accessLifetimeSeconds = 3600
let workerTokenFailure
const tokenCalls = Object.fromEntries(PROVIDERS.map(p => [p, 0]))
const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
  const at = `${url.hostname}${url.pathname}`
  if (workerMode && at === 'chatgpt.com/backend-api/wham/usage') process.send({ type: 'usage-request' })
  const provider = ({ 'auth.openai.com/oauth/token': 'codex', 'claude.ai/v1/oauth/token': 'claude', 'auth.x.ai/oauth2/token': 'grok', 'oauth2.googleapis.com/token': 'antigravity', 'api.github.com/copilot_internal/v2/token': 'copilot' })[at]
  if (provider && (workerMode || successfulTokens.has(provider))) {
    tokenCalls[provider]++
    if (workerMode) {
      const wait = release('token')
      process.send({ type: 'token-request' })
      await wait
      if (workerTokenFailure === 'permanent') return answer(400, { error: 'invalid_grant' })
      if (workerTokenFailure === 'transient') return answer(503, { error: 'temporarily_unavailable' })
    }
    return answer(200, {
      access_token: `fake-${provider}-at-refreshed`, refresh_token: `fake-${provider}-rt-refreshed`, expires_in: accessLifetimeSeconds,
      id_token: responseIdToken, token: 'fake-copilot-refreshed', expires_at: Math.floor(Date.now() / 1000) + 3600,
      ...(refreshExpirySeconds === undefined ? {} : { refresh_token_expires_in: refreshExpirySeconds }),
    })
  }
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
  effect: (fn, label) => {
    // This host drives discovery explicitly; it does not schedule daemon work.
    if (label === 'dsh-plugin-subscriptions: hourly model catalog refresh') return
    fn()
  },
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
plugin.apply(ctx, {
  pool: { enabled: false },
  // Worker races exercise usage and logout; fixed catalogs avoid the plugin's
  // independent startup discovery spending tokens before the commanded action.
  ...(workerMode ? { models: Object.fromEntries(PROVIDERS.map(provider => [provider, [{ id: 'offline-worker', name: 'Offline worker' }]])) } : {}),
})

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

if (workerMode) {
  process.send({ type: 'ready' })
  process.once('message', async message => {
    observeRead = message.observeRead === true
    accessLifetimeSeconds = message.accessLifetimeSeconds ?? 3600
    workerTokenFailure = message.tokenFailure
    try {
      let result
      if (message.action === 'refresh') result = await usage(message.provider)
      else if (message.action === 'status') await rpc('status', { provider: message.provider })
      else assert.equal((await rpc('logout', { provider: message.provider, account: KEY[message.provider] }))?.ok, true)
      process.send({ type: 'done', result })
    } catch (error) { process.send({ type: 'done', error: String(error) }) }
  })
  await new Promise(() => {})
}

function worker() {
  const child = fork(new URL(import.meta.url), ['--plugin', dir], {
    env: { PATH: process.env.PATH, HOME: home, DSH_HOME: process.env.DSH_HOME, SUBSCRIPTIONS_TEST_HOME: home, SUBSCRIPTIONS_TEST_WORKER: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const queued = [], waiting = [], seen = []
  const exited = new Promise(resolve => child.once('exit', resolve))
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('message', message => {
    seen.push(message.type)
    const index = waiting.findIndex(item => item.types.includes(message.type))
    if (index === -1) queued.push(message)
    else waiting.splice(index, 1)[0].resolve(message)
  })
  child.on('exit', (code, signal) => {
    for (const item of waiting.splice(0)) item.reject(new Error(`worker exited ${code}/${signal}: ${stderr}`))
  })
  return {
    count: type => seen.filter(value => value === type).length,
    send: message => child.send(message),
    async wait(...types) {
      const index = queued.findIndex(message => types.includes(message.type))
      if (index !== -1) return queued.splice(index, 1)[0]
      let timer
      try {
        return await Promise.race([
          new Promise((resolve, reject) => waiting.push({ types, resolve, reject })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`worker timed out waiting for ${types}: ${stderr}; pending ${JSON.stringify(queued)}`)), 15000) }),
        ])
      } finally { clearTimeout(timer) }
    },
    async close() {
      child.kill()
      await exited
    },
  }
}
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
  if (process.env.SUBSCRIPTIONS_TEST_FILTER && !name.includes(process.env.SUBSCRIPTIONS_TEST_FILTER)) return
  try { await fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++ }
}

console.log(`dsh-plugin-subscriptions ${version} (${dir})`)

for (const provider of PROVIDERS) {
  await check(`${provider}: parsing and unrelated writes preserve refresh-token expiry`, async () => {
    seed()
    put(provider, { ...session(provider), refreshTokenExpiresAt: 1900000000000 })
    await rpc('setDefault', { provider: 'codex', account: KEY.codex })
    assert.equal(stored()[provider].accounts[KEY[provider]].refreshTokenExpiresAt, 1900000000000)
  })
  await check(`${provider}: successful refresh preserves known refresh-token expiry`, async () => {
    seed()
    put(provider, { ...session(provider, 31), refreshTokenExpiresAt: 1900000000000 })
    successfulTokens.add(provider)
    try {
      if (provider === 'copilot') await listModels(provider)
      else await usage(provider)
      assert.equal(stored()[provider].accounts[KEY[provider]].accessToken, provider === 'copilot' ? 'fake-copilot-refreshed' : `fake-${provider}-at-refreshed`)
      assert.equal(stored()[provider].accounts[KEY[provider]].refreshTokenExpiresAt, 1900000000000)
    } finally { successfulTokens.delete(provider) }
  })
}

for (const provider of ['claude', 'grok', 'antigravity']) {
  await check(`${provider}: issuer refresh lifetime is recorded without a prior deadline`, async () => {
    seed()
    successfulTokens.add(provider)
    refreshExpirySeconds = 7200
    const before = Date.now()
    try {
      await usage(provider)
      const value = stored()[provider].accounts[KEY[provider]]
      assert.equal(value.accessToken, `fake-${provider}-at-refreshed`)
      assert.ok(value.refreshTokenExpiresAt >= before + 7200000 && value.refreshTokenExpiresAt <= Date.now() + 7200000, 'provider discarded the issuer refresh lifetime')
    } finally { successfulTokens.delete(provider); refreshExpirySeconds = undefined }
  })
}

await check('OAuth login records the expiry supplied by the token endpoint', async () => {
  seed()
  successfulTokens.add('codex')
  refreshExpirySeconds = 86400
  const before = Date.now()
  const attempt = { waitCode: async () => 'fake-code', pkce: { verifier: 'fake-verifier' }, redirectUri: 'http://localhost/fake', authorizeUrl: 'https://example.invalid/fake' }
  const flows = { start: async () => attempt }
  const controller = new plugin.SubscriptionsAuthController(flows, {}, () => {}, () => undefined)
  try {
    await controller.login('codex', 'oauth')
    await controller.settled('codex')
    const value = stored().codex.accounts[KEY.codex]
    assert.equal(value.accessToken, 'fake-codex-at-refreshed')
    assert.ok(value.refreshTokenExpiresAt >= before + 86400000 && value.refreshTokenExpiresAt <= Date.now() + 86400000, 'OAuth login lost refresh_token_expires_in')
  } finally { successfulTokens.delete('codex'); refreshExpirySeconds = undefined }
})

await check('successful refresh uses an explicitly renewed refresh-token expiry', async () => {
  seed()
  put('codex', { ...session('codex', 32), refreshTokenExpiresAt: 1800000000000 })
  successfulTokens.add('codex')
  refreshExpirySeconds = 172800
  const before = Date.now()
  try {
    await usage('codex')
    const value = stored().codex.accounts[KEY.codex]
    assert.ok(value.refreshTokenExpiresAt >= before + 172800000 && value.refreshTokenExpiresAt <= Date.now() + 172800000, 'wire refresh expiry did not replace the previous deadline')
  } finally { successfulTokens.delete('codex'); refreshExpirySeconds = undefined }
})

await check('OAuth login without an issuer refresh lifetime leaves expiry unknown', async () => {
  seed()
  successfulTokens.add('codex')
  const attempt = { waitCode: async () => 'fake-code', pkce: { verifier: 'fake-verifier' }, redirectUri: 'http://localhost/fake', authorizeUrl: 'https://example.invalid/fake' }
  const controller = new plugin.SubscriptionsAuthController({ start: async () => attempt }, {}, () => {}, () => undefined)
  try {
    await controller.login('codex', 'oauth')
    await controller.settled('codex')
    const value = stored().codex.accounts[KEY.codex]
    assert.equal(value.accessToken, 'fake-codex-at-refreshed')
    assert.equal(Object.hasOwn(value, 'refreshTokenExpiresAt'), false, 'a lifetime was invented without issuer evidence')
  } finally { successfulTokens.delete('codex') }
})

await check('unusable issuer refresh lifetimes leave login expiry unknown', async () => {
  successfulTokens.add('codex')
  const attempt = { waitCode: async () => 'fake-code', pkce: { verifier: 'fake-verifier' }, redirectUri: 'http://localhost/fake', authorizeUrl: 'https://example.invalid/fake' }
  try {
    for (const seconds of [-1, '86400', Number.MAX_VALUE]) {
      seed()
      refreshExpirySeconds = seconds
      const controller = new plugin.SubscriptionsAuthController({ start: async () => attempt }, {}, () => {}, () => undefined)
      await controller.login('codex', 'oauth')
      await controller.settled('codex')
      assert.equal(Object.hasOwn(stored().codex.accounts[KEY.codex], 'refreshTokenExpiresAt'), false, 'unusable lifetime was persisted as a deadline')
    }
  } finally { successfulTokens.delete('codex'); refreshExpirySeconds = undefined }
})

await check('Claude CLI login preserves an explicit refresh-token expiry', async () => {
  seed()
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-claude-import-at', refreshToken: 'fake-claude-import-rt', expiresAt: Date.now() + 3600000, emailAddress: KEY.claude, refreshTokenExpiresAt: 1920000000000 } }), { mode: 0o600 })
  try {
    const result = await rpc('login', { provider: 'claude', method: 'keychain' })
    assert.equal(result?.ok, true)
    assert.equal(stored().claude.accounts[KEY.claude].refreshTokenExpiresAt, 1920000000000)
  } finally { rmSync(join(home, '.claude'), { recursive: true, force: true }) }
})

await check('bound Claude refresh synchronizes a renewed refresh expiry to the CLI fixture', async () => {
  seed()
  const prior = { ...session('claude', 41), refreshTokenExpiresAt: 1900000000000, keychainBound: true }
  put('claude', prior)
  mkdirSync(join(home, '.claude'), { recursive: true })
  const source = join(home, '.claude/.credentials.json')
  writeFileSync(source, JSON.stringify({ claudeAiOauth: prior }), { mode: 0o600 })
  successfulTokens.add('claude')
  refreshExpirySeconds = 172800
  try {
    await usage('claude')
    const value = stored().claude.accounts[KEY.claude]
    assert.equal(value.accessToken, 'fake-claude-at-refreshed')
    assert.equal(JSON.parse(readFileSync(source, 'utf8')).claudeAiOauth.refreshTokenExpiresAt, value.refreshTokenExpiresAt, 'bound CLI source retained a stale refresh deadline')
  } finally {
    successfulTokens.delete('claude'); refreshExpirySeconds = undefined
    rmSync(join(home, '.claude'), { recursive: true, force: true })
  }
})

await check('Codex refresh may promote an existing account to its stable user identity', async () => {
  seed()
  responseIdToken = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: KEY.codex, chatgpt_user_id: 'fake-stable-user' } })).toString('base64url')}.fake`
  successfulTokens.add('codex')
  try {
    await usage('codex')
    const value = stored().codex.accounts['["acct-codex-keep","user","fake-stable-user"]']
    assert.equal(value?.accessToken, 'fake-codex-at-refreshed', 'compare-before-save rejected the account identity upgrade')
  } finally { successfulTokens.delete('codex'); responseIdToken = idToken }
})

await check('refresh lock still covers a rotated token with a short access lifetime', async () => {
  seed()
  const first = worker(), second = worker(), third = worker()
  try {
    await Promise.all([first.wait('ready'), second.wait('ready'), third.wait('ready')])
    first.send({ action: 'refresh', provider: 'codex', accessLifetimeSeconds: 1 })
    await first.wait('token-request')
    second.send({ action: 'refresh', provider: 'codex', accessLifetimeSeconds: 1 })
    const secondObserved = await second.wait('lock-wait', 'token-request')
    if (secondObserved.type === 'token-request') {
      first.send({ release: 'token' })
      second.send({ release: 'token' })
      await Promise.all([first.wait('done'), second.wait('done')])
      assert.fail('a second process spent the token before its first rotation settled')
    }
    first.send({ release: 'token' })
    await first.wait('done')
    await second.wait('token-request')
    third.send({ action: 'refresh', provider: 'codex', accessLifetimeSeconds: 1 })
    const observed = await third.wait('token-request', 'lock-wait')
    second.send({ release: 'token' })
    if (observed.type === 'token-request') third.send({ release: 'token' })
    else {
      await third.wait('token-request')
      third.send({ release: 'token' })
    }
    await Promise.all([second.wait('done'), third.wait('done')])
    assert.equal(observed.type, 'lock-wait', 'rotating a token changed its lock while a refresh was spending it')
  } finally { await Promise.all([first.close(), second.close(), third.close()]) }
})

await check('two processes spend a rotating refresh token only once', async () => {
  seed()
  const first = worker(), second = worker()
  try {
    await Promise.all([first.wait('ready'), second.wait('ready')])
    first.send({ action: 'refresh', provider: 'codex' })
    await first.wait('token-request')
    second.send({ action: 'refresh', provider: 'codex' })
    const observed = await second.wait('token-request', 'lock-wait')
    first.send({ release: 'token' })
    if (observed.type === 'token-request') second.send({ release: 'token' })
    await Promise.all([first.wait('done'), second.wait('done')])
    assert.equal(observed.type, 'lock-wait', 'a second process spent the same refresh token')
    assert.equal(stored().codex.accounts[KEY.codex].refreshToken, 'fake-codex-rt-refreshed')
  } finally { await Promise.all([first.close(), second.close()]) }
})

await check('two process store mutations preserve both logouts', async () => {
  seed()
  const first = worker(), second = worker()
  try {
    await Promise.all([first.wait('ready'), second.wait('ready')])
    first.send({ action: 'logout', provider: 'codex', observeRead: true })
    await first.wait('store-read')
    second.send({ action: 'logout', provider: 'claude', observeRead: true })
    const observed = await second.wait('store-read', 'lock-wait')
    first.send({ release: 'read' })
    if (observed.type === 'store-read') second.send({ release: 'read' })
    else {
      await second.wait('store-read')
      second.send({ release: 'read' })
    }
    await Promise.all([first.wait('done'), second.wait('done')])
    assert.equal(stored().codex?.accounts?.[KEY.codex], undefined, 'concurrent write restored Codex logout')
    assert.equal(stored().claude?.accounts?.[KEY.claude], undefined, 'concurrent write restored Claude logout')
    assert.ok(stored().grok.accounts[KEY.grok])
  } finally { await Promise.all([first.close(), second.close()]) }
})

await check('a refresh finishing after another process logs out cannot restore the account', async () => {
  seed()
  const child = worker()
  try {
    await child.wait('ready')
    child.send({ action: 'refresh', provider: 'codex' })
    await child.wait('token-request')
    await rpc('logout', { provider: 'codex', account: KEY.codex })
    child.send({ release: 'token' })
    await child.wait('done')
    assert.equal(stored().codex?.accounts?.[KEY.codex], undefined, 'late refresh resurrected a logged-out account')
  } finally { await child.close() }
})

await check('a logout during preemptive refresh also stops use of the still-valid old access token', async () => {
  seed()
  put('codex', session('codex', 89, Date.now() + 60000))
  const child = worker()
  try {
    await child.wait('ready')
    child.send({ action: 'refresh', provider: 'codex' })
    await child.wait('token-request')
    await rpc('logout', { provider: 'codex', account: KEY.codex })
    child.send({ release: 'token' })
    await child.wait('done')
    assert.equal(stored().codex?.accounts?.[KEY.codex], undefined)
    assert.equal(child.count('usage-request'), 0, 'preemptive fallback sent an access token after logout')
  } finally { await child.close() }
})

for (const tokenFailure of ['permanent', 'transient']) {
  await check(`logout during ${tokenFailure} refresh failure stops stale access-token fallback`, async () => {
    seed()
    put('codex', session('codex', 90, Date.now() + 60000))
    const child = worker()
    try {
      await child.wait('ready')
      child.send({ action: 'refresh', provider: 'codex', tokenFailure })
      await child.wait('token-request')
      await rpc('logout', { provider: 'codex', account: KEY.codex })
      child.send({ release: 'token' })
      const done = await child.wait('done')
      assert.equal(child.count('usage-request'), 0, 'failed refresh used an access token after logout')
      assert.match(done.result?.error?.message ?? '', /logged out/, 'logout was reported as another refresh failure')
    } finally { await child.close() }
  })
}

await check('a refresh finishing after a new login cannot overwrite the replacement', async () => {
  seed()
  const child = worker()
  try {
    await child.wait('ready')
    child.send({ action: 'refresh', provider: 'codex' })
    await child.wait('token-request')
    put('codex', { ...session('codex', 88, Date.now() + 3600000), refreshTokenExpiresAt: 1910000000000 })
    child.send({ release: 'token' })
    await child.wait('done')
    assert.equal(stored().codex.accounts[KEY.codex].refreshToken, 'fake-codex-rt-88', 'late refresh overwrote a replacement login')
    assert.equal(stored().codex.accounts[KEY.codex].refreshTokenExpiresAt, 1910000000000)
  } finally { await child.close() }
})

await check('a replacement access token with the same refresh token supersedes an in-flight refresh', async () => {
  seed()
  const child = worker()
  try {
    await child.wait('ready')
    child.send({ action: 'refresh', provider: 'codex' })
    await child.wait('token-request')
    put('codex', { ...session('codex'), accessToken: 'fake-external-access', expiresAt: Date.now() + 3600000 })
    child.send({ release: 'token' })
    await child.wait('done')
    assert.equal(stored().codex.accounts[KEY.codex].accessToken, 'fake-external-access', 'compare-before-save ignored an access-token replacement')
  } finally { await child.close() }
})

await check('legacy migration cannot restore an account another process logged out', async () => {
  seed()
  const legacy = join(process.env.DSH_HOME, 'plugins/router/auth.json')
  mkdirSync(join(legacy, '..'), { recursive: true })
  writeFileSync(legacy, JSON.stringify(stored()), { mode: 0o600 })
  rmSync(store)
  const first = worker(), second = worker()
  try {
    await Promise.all([first.wait('ready'), second.wait('ready')])
    first.send({ action: 'status', provider: 'codex', observeRead: true })
    await first.wait('store-read')
    second.send({ action: 'logout', provider: 'codex' })
    const observed = await second.wait('done', 'lock-wait')
    first.send({ release: 'read' })
    await first.wait('done')
    if (observed.type !== 'done') await second.wait('done')
    assert.equal(stored().codex?.accounts?.[KEY.codex], undefined, 'legacy migration restored a concurrent logout')
  } finally {
    await Promise.all([first.close(), second.close()])
    rmSync(join(process.env.DSH_HOME, 'plugins/router'), { recursive: true, force: true })
  }
})

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

assert.ok(passed + failed > 0, 'test filter selected no checks')
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
