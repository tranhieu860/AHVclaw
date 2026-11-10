// Offline regression at the real subscriptions apply() + catalog dumper boundary.
// Only peer interfaces and HTTP are replaced; no real credentials or sockets.
import assert from 'node:assert/strict'
import childProcess, { fork, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const oldModel = { id: 'claude-old', name: 'Old Claude' }
const newModel = { id: 'claude-fable-5-2', name: 'New Claude' }
const providerModels = {
  claude: { old: oldModel, fresh: newModel },
  grok: { old: { id: 'grok-old', name: 'Old Grok' }, fresh: { id: 'grok-new', name: 'New Grok' } },
  antigravity: { old: { id: 'gemini-old', name: 'Old Gemini' }, fresh: { id: 'gemini-new', name: 'New Gemini' } },
  copilot: { old: { id: 'copilot-old', name: 'Old Copilot' }, fresh: { id: 'copilot-new', name: 'New Copilot' } },
}
const vscodeReleasesUrl = 'https://update.code.visualstudio.com/api/releases/stable'

if (process.env.AHV_MODELS_TEST_WORKER === '1') {
  assert.ok(process.env.HOME && process.env.DSH_HOME)
  const fixture = JSON.parse(process.env.AHV_MODELS_TEST_CASE)
  childProcess.execFileSync = (file, args) => {
    assert.ok(fixture.legacy, 'bounded listing must not synchronously probe a local CLI')
    assert.equal(file, 'claude')
    assert.deepEqual(args, ['--version'])
    return '2.1.100 (Claude Code)'
  }
  syncBuiltinESMExports()
  const calls = [], aborted = [], registryCalls = [], versionCalls = [], httpCalls = [], catalogCalls = []
  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url)
    httpCalls.push(requestUrl)
    if (requestUrl.startsWith('https://registry.npmjs.org/')) {
      registryCalls.push(requestUrl)
      if (fixture.registryHang) return new Promise(() => {})
      return Response.json({ version: '2.1.100' })
    }
    if (requestUrl === vscodeReleasesUrl) {
      versionCalls.push(requestUrl)
      return Response.json(['1.107.0'])
    }
    const account = new Headers(init.headers).get('authorization')
    calls.push(account)
    catalogCalls.push({ url: requestUrl, account })
    const codex = requestUrl.startsWith('https://chatgpt.com/backend-api/codex/models?client_version=')
    const grok = requestUrl === 'https://api.x.ai/v1/models'
    const grokCli = requestUrl === 'https://cli-chat-proxy.grok.com/v1/models'
    const antigravity = [
      'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    ].includes(requestUrl)
    const copilot = requestUrl === 'https://api.githubcopilot.com/models'
    assert.ok(codex || grok || grokCli || antigravity || copilot || requestUrl === 'https://api.anthropic.com/v1/models?beta=true', `unexpected fixture HTTP: ${requestUrl}`)
    init.signal?.addEventListener('abort', () => aborted.push(account), { once: true })
    if (fixture.behavior === 'hang') return new Promise(() => {}) // Deliberately ignores abort.
    if (fixture.behavior === 'network') throw new TypeError('fixture network failure')
    if (fixture.behavior === '401') return Response.json({ error: { message: 'fixture unauthorized' } }, { status: 401 })
    if (fixture.behavior === '502') return Response.json({ error: { message: 'fixture unavailable' } }, { status: 502 })
    if (fixture.behavior === 'abort') throw new DOMException('fixture cancelled', 'AbortError')
    if (fixture.behavior === 'delayed') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 400)
        if (fixture.legacy) init.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('fixture cancelled', 'AbortError'))
        }, { once: true })
      })
    }
    if (codex) return Response.json({ models: [{ slug: 'gpt-new', display_name: 'New GPT' }] })
    if (grok || grokCli) return Response.json({ data: [{ id: providerModels.grok.fresh.id, name: providerModels.grok.fresh.name }] })
    if (antigravity) return Response.json({ models: { [providerModels.antigravity.fresh.id]: { displayName: providerModels.antigravity.fresh.name } } })
    if (copilot) return Response.json({ data: [{ ...providerModels.copilot.fresh, model_picker_enabled: true, supported_endpoints: ['/chat/completions'] }] })
    return Response.json({ data: [oldModel, newModel].map(m => ({ id: m.id, display_name: m.name })) })
  }
  const disposers = [], services = new Map(), adapters = new Map()
  const llm = {
    registerAdapter(ids, adapter) {
      for (const id of ids) adapters.set(id, adapter)
      return Object.assign(() => {}, { replace() {}, dispose() {} })
    },
    listProviders: () => [...adapters].map(([id, adapter]) => adapter.providerInfo(id)),
    listModels: id => adapters.get(id).listModels(id),
  }
  services.set('llm', llm)
  services.set('loader', { await: async () => {} })
  services.set('appExit', code => {
    for (const dispose of disposers.reverse()) dispose()
    const finish = () => {
      process.exitCode = code
      if (typeof process.send === 'function') process.send({ calls, aborted, registryCalls, versionCalls, httpCalls, catalogCalls }, () => process.disconnect())
    }
    if (fixture.lateResult) setTimeout(finish, 450)
    else finish()
  })
  const ctx = {
    llm,
    get: name => services.get(name),
    provide: (name, value) => services.set(name, value),
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    inject() {},
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  }
  const plugin = await import(pathToFileURL(join(process.env.AHV_MODELS_TEST_PLUGIN, 'lib/index.js')))
  plugin.apply(ctx, { providers: fixture.twoProviders ? ['claude', 'codex'] : [fixture.provider ?? 'claude'], pool: { enabled: false } })
  const dumper = await import(pathToFileURL(join(root, 'packages/bundle/ahv/src/bot-list-models.ts')))
  dumper.apply(ctx)
} else {
  const plugin = process.env.AHV_MODELS_TEST_PLUGIN ?? dirname(createRequire(join(root, 'packages/bundle/ahv/package.json')).resolve('dsh-plugin-subscriptions/package.json'))
  assert.equal(JSON.parse(readFileSync(join(plugin, 'package.json'))).version, '0.9.12')

  async function listing(t, fixture = {}) {
    const provider = fixture.provider ?? 'claude'
    const home = mkdtempSync(join(tmpdir(), 'ahv-1280-'))
    t.after(() => rmSync(home, { recursive: true, force: true }))
    const dshHome = join(home, '.dsh'), store = join(dshHome, 'plugins/subscriptions')
    mkdirSync(store, { recursive: true })
    const accounts = fixture.loggedOut ? [] : ['one@fixture.test', ...(fixture.twoAccounts ? ['two@fixture.test'] : [])]
    writeFileSync(join(store, 'auth.json'), JSON.stringify({ [provider]: {
      default: accounts[0], accounts: Object.fromEntries(accounts.map(key => [key, {
        accessToken: `fake-${key}`, refreshToken: `fake-refresh-${key}`,
        expiresAt: Date.now() + (fixture.expired ? -1000 : 86_400_000),
        ...(provider === 'claude' ? { emailAddress: key } : { account: key }),
        ...(provider === 'antigravity' ? { projectId: `fake-project-${key}` } : {}),
      }])),
    }, ...(fixture.twoProviders ? { codex: { default: 'codex-fixture', accounts: { 'codex-fixture': {
      accessToken: 'fake-codex', refreshToken: 'fake-refresh-codex', expiresAt: Date.now() + 86_400_000, accountId: 'codex-fixture',
    } } } } : {}) }), { mode: 0o600 })
    const seededAt = Date.now() - (fixture.ageMs ?? 7_200_000)
    const snapshot = { at: seededAt, models: [providerModels[provider].old] }
    const before = fixture.missing ? undefined : JSON.stringify({
      [provider]: snapshot,
      ...(fixture.twoProviders ? { codex: { at: seededAt, models: [{ id: 'gpt-old', name: 'Old GPT' }] } } : {}),
      ...(fixture.twoAccounts ? { accounts: { [provider]: { 'two@fixture.test': snapshot } } } : {}),
    }, null, 3) + '\n'
    const path = join(store, 'models.json')
    if (before !== undefined) writeFileSync(path, before)
    const env = {
      PATH: process.env.PATH, HOME: home, DSH_HOME: dshHome,
      AHV_MODELS_TEST_WORKER: '1', AHV_MODELS_TEST_PLUGIN: plugin,
      AHV_MODELS_TEST_CASE: JSON.stringify(fixture),
      ...(fixture.legacy ? {} : { AHV_MODELS_LIST_ONESHOT: '1' }),
      AHV_MODELS_REFRESH_WAIT_MS: String(fixture.waitMs ?? 200),
    }
    const start = performance.now()
    const child = fork(fileURLToPath(import.meta.url), [], {
      execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--import', join(here, 'helpers/subscriptions-register.mjs')],
      env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill() })
    let stdout = '', stderr = '', diagnostic
    child.stdout.on('data', b => { stdout += b })
    child.stderr.on('data', b => { stderr += b })
    child.on('message', message => { diagnostic = message })
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`fixture timeout: ${stderr}`)) }, 5000)
      child.once('error', reject)
      child.once('close', code => { clearTimeout(timer); resolve(code) })
    })
    const elapsedMs = performance.now() - start
    assert.equal(code, 0, stderr)
    let payload
    assert.doesNotThrow(() => { payload = JSON.parse(stdout) }, `invalid stdout: ${stdout}; stderr: ${stderr}`)
    assert.equal(stdout, JSON.stringify(payload) + '\n', 'stdout must be exactly one JSON line')
    assert.ok(diagnostic)
    let after
    try { after = readFileSync(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    return { payload, before, after, seededAt, elapsedMs, ...diagnostic, home, dshHome }
  }

  test('reproduction: startup discovery is aborted by the catalog dumper exit', async t => {
    const result = await listing(t, { legacy: true, behavior: 'delayed' })
    assert.deepEqual(result.calls, ['Bearer fake-one@fixture.test'])
    assert.deepEqual(result.aborted, result.calls)
    assert.equal(result.after, result.before)
    assert.ok(!result.payload.models.some(m => m.model_id === newModel.id))
    t.diagnostic(`legacy stale listing ${result.elapsedMs.toFixed(1)} ms; started=1, aborted=1, unchanged cache`)
  })

  test('T1 stale two hours: print the new model and await the disk snapshot', async t => {
    const r = await listing(t)
    assert.ok(r.payload.models.some(m => m.model_id === newModel.id), 'new model must be printed')
    assert.equal(r.calls.length, 1)
    assert.ok(JSON.parse(r.after).claude.at > r.seededAt)
    assert.ok(JSON.parse(r.after).claude.models.some(m => m.id === newModel.id))
  })

  test('T2 fresh ten minutes: no discovery', async t => {
    const r = await listing(t, { ageMs: 600_000 })
    assert.equal(r.calls.length, 0)
    assert.equal(r.registryCalls.length, 0)
    assert.equal(r.after, r.before)
  })

  for (const behavior of ['hang', 'network', '401', 'abort']) {
    test(`T3/T4 ${behavior}: keep the exact saved bytes, one probe, exit 0`, async t => {
      const r = await listing(t, { behavior })
      assert.deepEqual(r.payload.models.map(m => m.model_id), [oldModel.id])
      assert.equal(r.after, r.before)
      assert.equal(r.calls.length, 1)
      if (behavior === 'hang') {
        assert.deepEqual(r.aborted, r.calls)
        assert.ok(r.elapsedMs < 1500, `unbounded wait: ${r.elapsedMs}`)
        t.diagnostic(`200 ms budget, command worker ${r.elapsedMs.toFixed(1)} ms`)
      }
    })
  }

  test('T5 no login: no discovery', async t => {
    const r = await listing(t, { loggedOut: true })
    assert.equal(r.calls.length, 0)
    assert.equal(r.payload.model_count, 0)
    assert.equal(r.after, r.before)
  })

  test('missing snapshot: refresh once before printing', async t => {
    const r = await listing(t, { missing: true })
    assert.ok(r.payload.models.some(m => m.model_id === newModel.id))
    assert.equal(r.calls.length, 1)
    assert.ok(JSON.parse(r.after).claude.at > r.seededAt)
  })

  test('missing snapshot and timeout: no second probe while printing fallback', async t => {
    const r = await listing(t, { missing: true, behavior: 'hang' })
    assert.equal(r.calls.length, 1)
    assert.equal(r.after, undefined)
  })

  test('two authenticated accounts share one deadline and each probe only once', async t => {
    const r = await listing(t, { twoAccounts: true, behavior: 'hang' })
    assert.deepEqual(r.calls.sort(), ['Bearer fake-one@fixture.test', 'Bearer fake-two@fixture.test'])
    assert.equal(r.after, r.before)
    assert.equal(r.aborted.length, 2)
    assert.ok(r.elapsedMs < 1500)
  })

  test('two providers start in parallel and share the 200 ms deadline', async t => {
    const r = await listing(t, { twoProviders: true, behavior: 'hang' })
    assert.deepEqual(r.calls.sort(), ['Bearer fake-codex', 'Bearer fake-one@fixture.test'])
    assert.equal(r.aborted.length, 2)
    assert.equal(r.after, r.before)
    assert.ok(r.elapsedMs < 1500)
  })

  test('an expired stored session still gets one discovery attempt without rotating login tokens', async t => {
    const r = await listing(t, { expired: true })
    assert.ok(r.payload.models.some(m => m.model_id === newModel.id))
    assert.equal(r.calls.length, 1)
  })

  test('a late successful response after cancellation cannot overwrite the snapshot', async t => {
    const r = await listing(t, { behavior: 'delayed', lateResult: true })
    assert.deepEqual(r.payload.models.map(m => m.model_id), [oldModel.id])
    assert.equal(r.after, r.before)
    assert.equal(r.calls.length, 1)
  })

  test('a hanging CLI-version registry is inside the same refresh deadline', async t => {
    const r = await listing(t, { registryHang: true })
    assert.equal(r.calls.length, 0)
    assert.equal(r.registryCalls.length, 1)
    assert.equal(r.after, r.before)
    assert.ok(r.elapsedMs < 1500)
  })

  for (const provider of ['grok', 'antigravity', 'copilot']) {
    const model = providerModels[provider]
    const primaryUrl = {
      grok: 'https://api.x.ai/v1/models',
      antigravity: 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      copilot: 'https://api.githubcopilot.com/models',
    }[provider]
    for (const behavior of ['success', 'network', '401', ...(provider === 'antigravity' ? ['502'] : [])]) {
      test(`R4 ${provider} ${behavior}: each stored account makes one actual catalog HTTP request`, async t => {
        const r = await listing(t, { provider, behavior, twoAccounts: true })
        assert.deepEqual([...r.calls].sort(), ['Bearer fake-one@fixture.test', 'Bearer fake-two@fixture.test'])
        assert.equal(r.catalogCalls.length, 2)
        assert.ok(r.catalogCalls.every(call => call.url === primaryUrl), 'optional catalogs and fallback origins must be blocked before HTTP')
        assert.equal(r.registryCalls.length, 0)
        assert.equal(r.versionCalls.length, provider === 'copilot' ? 1 : 0)
        assert.equal(r.httpCalls.length, 2 + r.versionCalls.length, 'no authentication or other hidden HTTP requests')
        if (behavior === 'success') {
          assert.ok(r.payload.models.some(m => m.model_id === model.fresh.id))
          const saved = JSON.parse(r.after)
          for (const snapshot of [saved[provider], saved.accounts[provider]['two@fixture.test']]) {
            assert.ok(snapshot.at > r.seededAt)
            assert.ok(snapshot.models.some(m => m.id === model.fresh.id))
          }
        } else {
          assert.deepEqual(r.payload.models.map(m => m.model_id), [model.old.id])
          assert.equal(r.after, r.before)
        }
      })
    }

    test(`R4 ${provider} fresh ten minutes: no HTTP including version discovery`, async t => {
      const r = await listing(t, { provider, twoAccounts: true, ageMs: 600_000 })
      assert.deepEqual(r.httpCalls, [])
      assert.deepEqual(r.catalogCalls, [])
      assert.deepEqual(r.registryCalls, [])
      assert.deepEqual(r.versionCalls, [])
      assert.deepEqual(r.payload.models.map(m => m.model_id), [model.old.id])
      assert.equal(r.after, r.before)
    })
  }

  test('baseline fresh command timing (real CLI, harness availability reported)', async t => {
    const r = await listing(t, { legacy: true, ageMs: 120_000 })
    const start = performance.now()
    const command = spawnSync(process.execPath, [join(root, 'scripts/prod/ahv-bot.mjs'), 'models', 'list', '--json'], {
      env: { PATH: process.env.PATH, HOME: r.home, DSH_HOME: r.dshHome, AHV_FORK: root }, encoding: 'utf8', timeout: 8000,
    })
    assert.equal(command.status, 0, command.stderr)
    JSON.parse(command.stdout)
    t.diagnostic(`legacy fresh worker ${r.elapsedMs.toFixed(1)} ms; real CLI ${(performance.now() - start).toFixed(1)} ms: ${command.stdout.trim()}`)
  })
}
