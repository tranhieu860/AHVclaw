// Offline regression at the real subscriptions apply() + catalog dumper boundary.
// Only peer interfaces and HTTP are replaced; no real credentials or sockets.
import assert from 'node:assert/strict'
import childProcess, { fork, spawnSync } from 'node:child_process'
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
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
  codex: { old: { id: 'gpt-old', name: 'Old GPT' }, fresh: { id: 'gpt-new', name: 'New GPT' } },
  grok: { old: { id: 'grok-old', name: 'Old Grok' }, fresh: { id: 'grok-new', name: 'New Grok' } },
  antigravity: { old: { id: 'gemini-old', name: 'Old Gemini' }, fresh: { id: 'gemini-new', name: 'New Gemini' } },
  copilot: { old: { id: 'copilot-old', name: 'Old Copilot' }, fresh: { id: 'copilot-new', name: 'New Copilot' } },
}
const vscodeReleasesUrl = 'https://update.code.visualstudio.com/api/releases/stable'
const rejectedNotice = provider => `subscriptions: ${provider}: token bị từ chối, danh sách chưa làm mới; sẽ tự mới khi đăng nhập được gia hạn.\n`

if (process.env.AHV_MODELS_TEST_WORKER === '1') {
  assert.ok(process.env.HOME && process.env.DSH_HOME)
  const fixture = JSON.parse(process.env.AHV_MODELS_TEST_CASE)
  const credentialsPath = join(process.env.HOME, '.claude/.credentials.json')
  const catalogPath = join(process.env.DSH_HOME, 'plugins/subscriptions/models.json')
  let credentialsReads = 0, diskAtRefreshReturn, printedAtRefreshReturn, printed = false, startupProbe
  const read = fs.readFileSync
  fs.readFileSync = (path, ...args) => {
    if (String(path) === credentialsPath) credentialsReads++
    return read(path, ...args)
  }
  if (fixture.checkPersistedAtReturn) {
    const rename = fsPromises.rename
    fsPromises.rename = async (from, to) => {
      if (String(to) === catalogPath) await new Promise(resolve => setTimeout(resolve, 80))
      return rename(from, to)
    }
  }
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
    startupProbe?.()
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
    if ((fixture.sourceCase || fixture.expired) && account !== 'Bearer cc-fresh'
      || fixture.fleet && account === 'Bearer fake-three@fixture.test') {
      return Response.json({ error: { message: 'fixture rejected old token' } }, { status: fixture.rejectStatus ?? 401 })
    }
    if (fixture.behavior === 'hang') return new Promise(() => {}) // Deliberately ignores abort.
    if (fixture.behavior === 'network') throw new TypeError('fixture network failure')
    if (fixture.behavior === '401') return Response.json({ error: { message: 'fixture unauthorized' } }, { status: 401 })
    if (fixture.behavior === '403') return Response.json({ error: { message: 'fixture forbidden' } }, { status: 403 })
    if (fixture.behavior === '502') return Response.json({ error: { message: 'fixture unavailable' } }, { status: 502 })
    if (fixture.behavior === 'abort') throw new DOMException('fixture cancelled', 'AbortError')
    if (fixture.behavior === 'delayed') {
      await new Promise((resolve, reject) => {
        const timer = fixture.legacy ? undefined : setTimeout(resolve, 400)
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
    if (fixture.goodDelayMs) await new Promise(resolve => setTimeout(resolve, fixture.goodDelayMs))
    const accountModel = account === 'Bearer fake-two@fixture.test' ? 'claude-account-two' : 'claude-account-one'
    return Response.json({ data: [...[oldModel, newModel].map(m => ({ id: m.id, display_name: m.name })),
      ...(fixture.fleet ? [{ id: accountModel, display_name: accountModel }] : [])] })
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
  services.set('loader', { await: async () => {
    // The legacy reproduction must dispose a request that has already started.
    if (fixture.legacy && fixture.behavior === 'delayed' && catalogCalls.length === 0) {
      await new Promise(resolve => { startupProbe = resolve })
    }
  } })
  services.set('appExit', code => {
    for (const dispose of disposers.reverse()) dispose()
    const finish = () => {
      process.exitCode = code
      if (typeof process.send === 'function') process.send({ calls, aborted, registryCalls, versionCalls, httpCalls, catalogCalls,
        credentialsReads, diskAtRefreshReturn, printedAtRefreshReturn, refreshProvided: services.has('subscriptionsCatalogRefresh'), hourlyRegistered }, () => process.disconnect())
    }
    if (fixture.lateResult) setTimeout(finish, 450)
    else finish()
  })
  let hourlyRegistered = false
  const ctx = {
    llm,
    get: name => services.get(name),
    provide(name, value) {
      services.set(name, fixture.checkPersistedAtReturn && name === 'subscriptionsCatalogRefresh' ? async signal => {
        await value(signal)
        diskAtRefreshReturn = JSON.parse(readFileSync(catalogPath, 'utf8')).claude.at
        printedAtRefreshReturn = printed
      } : value)
    },
    effect(fn, label) {
      if (label === 'dsh-plugin-subscriptions: hourly model catalog refresh') hourlyRegistered = true
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject() {},
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  }
  const plugin = await import(pathToFileURL(join(process.env.AHV_MODELS_TEST_PLUGIN, 'lib/index.js')))
  plugin.apply(ctx, { providers: fixture.twoProviders ? ['claude', 'codex'] : [fixture.provider ?? 'claude'], pool: { enabled: false } })
  if (fixture.daemonMode) {
    // Observe startup's first HTTP request before disposing, without invoking the one-shot entry.
    await new Promise((resolve, reject) => {
      if (catalogCalls.length) return resolve()
      const timeout = setTimeout(() => reject(new Error('daemon startup never probed')), 500)
      startupProbe = () => { clearTimeout(timeout); resolve() }
    }).catch(() => {})
    process.stdout.write(JSON.stringify({ daemon: true }) + '\n')
    services.get('appExit')(0)
  } else {
  const dumper = await import(pathToFileURL(join(root, 'packages/bundle/ahv/src/bot-list-models.ts')))
  const write = dumper.internals.stdout.write.bind(dumper.internals.stdout)
  dumper.internals.stdout = { write(chunk) { printed = true; return write(chunk) } }
  dumper.apply(ctx)
  }
} else {
  const plugin = process.env.AHV_MODELS_TEST_PLUGIN ?? dirname(createRequire(join(root, 'packages/bundle/ahv/package.json')).resolve('dsh-plugin-subscriptions/package.json'))
  assert.equal(JSON.parse(readFileSync(join(plugin, 'package.json'))).version, '0.9.12')

  async function listing(t, fixture = {}) {
    const provider = fixture.provider ?? 'claude'
    const home = mkdtempSync(join(tmpdir(), 'ahv-1280-'))
    t.after(() => rmSync(home, { recursive: true, force: true }))
    const dshHome = join(home, '.dsh'), store = join(dshHome, 'plugins/subscriptions')
    mkdirSync(store, { recursive: true })
    const accounts = fixture.loggedOut ? [] : ['one@fixture.test', ...(fixture.twoAccounts || fixture.fleet ? ['two@fixture.test'] : []), ...(fixture.fleet ? ['three@fixture.test'] : [])]
    const selected = fixture.selectedRejected ? accounts[2] : accounts[0]
    writeFileSync(join(store, 'auth.json'), JSON.stringify({ [provider]: {
      default: selected, accounts: Object.fromEntries(accounts.map(key => [key, {
        accessToken: `fake-${key}`, refreshToken: `fake-refresh-${key}`,
        expiresAt: Date.now() + (fixture.expired || fixture.fleet && key === 'three@fixture.test' ? -1000 : 86_400_000),
        ...(fixture.keychainBound ? { keychainBound: true } : {}),
        ...(provider === 'claude' ? { emailAddress: key } : provider === 'codex' ? { accountId: key } : { account: key }),
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
      ...(accounts.length > 1 ? { accounts: { [provider]: Object.fromEntries(accounts.filter(key => key !== selected).map(key => [key, snapshot])) } } : {}),
    }, null, 3) + '\n'
    const path = join(store, 'models.json')
    if (before !== undefined) writeFileSync(path, before)
    const credentialsPath = join(home, '.claude/.credentials.json')
    if (fixture.sourceCase && fixture.sourceCase !== 'absent') {
      mkdirSync(dirname(credentialsPath), { recursive: true })
      writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: {
        accessToken: fixture.sourceCase === 'same' ? 'fake-one@fixture.test' : 'cc-fresh',
        refreshToken: 'fake-cc-refresh', expiresAt: Date.now() + (fixture.sourceCase === 'expired' ? -1000 : fixture.sourceCase === 'nearExpiry' ? 30_000 : 86_400_000),
        scopes: ['user:inference'],
      } }, null, 3) + '\n', { mode: 0o600 })
    }
    const bytes = file => { try { return readFileSync(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error } }
    const authBefore = bytes(join(store, 'auth.json')), credentialsBefore = bytes(credentialsPath)
    const env = {
      PATH: process.env.PATH, HOME: home, DSH_HOME: dshHome,
      AHV_MODELS_TEST_WORKER: '1', AHV_MODELS_TEST_PLUGIN: plugin,
      AHV_MODELS_TEST_CASE: JSON.stringify(fixture),
      ...(fixture.legacy ? {} : { AHV_MODELS_LIST_ONESHOT: '1' }),
      AHV_MODELS_REFRESH_WAIT_MS: String(fixture.waitMs ?? 3000),
    }
    if (fixture.daemonMode === 'unset') delete env.AHV_MODELS_LIST_ONESHOT
    else if (fixture.daemonMode) env.AHV_MODELS_LIST_ONESHOT = fixture.daemonMode === 'empty' ? '' : '0'
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
    assert.equal(bytes(join(store, 'auth.json')), authBefore, 'listing must not write auth.json')
    assert.equal(bytes(credentialsPath), credentialsBefore, 'listing must not write Claude Code credentials')
    assert.ok(diagnostic.httpCalls.every(url => !/oauth|token/i.test(new URL(url).pathname)), 'no token grant request')
    let after
    try { after = readFileSync(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    return { payload, before, after, seededAt, elapsedMs, ...diagnostic, home, dshHome, stderr }
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

  for (const behavior of ['hang', 'network', '401', '403', 'abort']) {
    test(`T3/T4 ${behavior}: keep the exact saved bytes, one probe, exit 0`, async t => {
      const r = await listing(t, { behavior, ...(behavior === 'hang' ? { waitMs: 200 } : {}) })
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
    const r = await listing(t, { missing: true, behavior: 'hang', waitMs: 200 })
    assert.equal(r.calls.length, 1)
    assert.equal(r.after, undefined)
  })

  test('two authenticated accounts share one deadline and each probe only once', async t => {
    const r = await listing(t, { twoAccounts: true, behavior: 'hang', waitMs: 200 })
    assert.deepEqual(r.calls.sort(), ['Bearer fake-one@fixture.test', 'Bearer fake-two@fixture.test'])
    assert.equal(r.after, r.before)
    assert.equal(r.aborted.length, 2)
    assert.ok(r.elapsedMs < 1500)
  })

  test('two providers start in parallel and share the 200 ms deadline', async t => {
    const r = await listing(t, { twoProviders: true, behavior: 'hang', waitMs: 200 })
    assert.deepEqual(r.calls.sort(), ['Bearer fake-codex', 'Bearer fake-one@fixture.test'])
    assert.equal(r.aborted.length, 2)
    assert.equal(r.after, r.before)
    assert.ok(r.elapsedMs < 1500)
  })

  for (const rejectStatus of [401, 403]) test(`B2 expired stored session rejected ${rejectStatus}: one probe, old catalog, one stderr notice`, async t => {
    const r = await listing(t, { expired: true, rejectStatus })
    assert.deepEqual(r.payload.models.map(m => m.model_id), [oldModel.id])
    assert.equal(r.after, r.before)
    assert.equal(r.calls.length, 1)
    assert.equal(r.stderr, rejectedNotice('claude'))
  })

  for (const behavior of ['401', '403']) test(`S2 Codex ${behavior}: exactly one anonymous stderr notice per rejected account`, async t => {
    const r = await listing(t, { provider: 'codex', twoAccounts: true, behavior })
    assert.equal(r.calls.length, 2)
    assert.deepEqual(r.payload.models.map(m => m.model_id), ['gpt-old'])
    assert.equal(r.after, r.before)
    assert.equal(r.stderr, rejectedNotice('codex').repeat(2))
  })

  for (const missing of [false, true]) {
    test(`B1 keychainBound uses new Claude Code token, snapshot ${missing ? 'missing' : 'stale'}`, async t => {
      const r = await listing(t, { expired: true, keychainBound: true, sourceCase: 'fresh', missing })
      assert.deepEqual(r.calls, ['Bearer cc-fresh'])
      assert.ok(r.payload.models.some(m => m.model_id === newModel.id))
      assert.ok(JSON.parse(r.after).claude.at > r.seededAt)
      assert.equal(r.credentialsReads, 1)
      assert.equal(r.stderr, '')
    })
  }

  for (const sourceCase of ['absent', 'same', 'expired', 'nearExpiry']) {
    test(`B1 keychainBound source ${sourceCase}: stored token rejected, snapshot unchanged`, async t => {
      const r = await listing(t, { expired: true, keychainBound: true, sourceCase })
      assert.deepEqual(r.calls, ['Bearer fake-one@fixture.test'])
      assert.deepEqual(r.payload.models.map(m => m.model_id), [oldModel.id])
      assert.equal(r.after, r.before)
      assert.equal(r.credentialsReads, 1)
      assert.equal(r.stderr, rejectedNotice('claude'))
    })
  }

  test('B1 non-bound account never reads or uses Claude Code credentials', async t => {
    const r = await listing(t, { expired: true, sourceCase: 'fresh' })
    assert.deepEqual(r.calls, ['Bearer fake-one@fixture.test'])
    assert.deepEqual(r.payload.models.map(m => m.model_id), [oldModel.id])
    assert.equal(r.after, r.before)
    assert.equal(r.credentialsReads, 0)
    assert.equal(r.stderr, rejectedNotice('claude'))
  })

  for (const daemonMode of ['unset', 'empty', 'zero']) {
    test(`B3 daemon env ${daemonMode}: registers hourly startup, no one-shot service`, async t => {
      const r = await listing(t, { legacy: true, daemonMode, behavior: 'hang' })
      assert.equal(r.hourlyRegistered, true)
      assert.equal(r.refreshProvided, false)
      assert.deepEqual(r.calls, ['Bearer fake-one@fixture.test'])
    })
  }

  test('B4 refresh promise settles only after the new at is already on disk, before printing', async t => {
    const r = await listing(t, { checkPersistedAtReturn: true, waitMs: 1000 })
    assert.ok(r.diskAtRefreshReturn > r.seededAt, `disk still stale when refresh returned: ${r.diskAtRefreshReturn}`)
    assert.equal(r.printedAtRefreshReturn, false)
    assert.ok(r.payload.models.some(m => m.model_id === newModel.id))
  })

  for (const selectedRejected of [false, true]) {
    test(`B5 three accounts, selected token ${selectedRejected ? 'rejected' : 'valid'}`, async t => {
      const r = await listing(t, { fleet: true, selectedRejected })
      assert.deepEqual(r.calls.slice().sort(), ['Bearer fake-one@fixture.test', 'Bearer fake-two@fixture.test', 'Bearer fake-three@fixture.test'].sort())
      const before = JSON.parse(r.before), after = JSON.parse(r.after)
      const selected = selectedRejected ? 'three@fixture.test' : 'one@fixture.test'
      const snapshot = (store, key) => key === selected ? store.claude : store.accounts.claude[key]
      for (const key of ['one@fixture.test', 'two@fixture.test']) {
        assert.ok(snapshot(after, key).at > r.seededAt)
        assert.ok(snapshot(after, key).models.some(m => m.id === newModel.id))
      }
      assert.deepEqual(snapshot(after, 'three@fixture.test'), snapshot(before, 'three@fixture.test'))
      assert.ok(r.payload.models.some(m => m.model_id === newModel.id))
      assert.ok(r.payload.models.some(m => m.model_id === 'claude-account-one'))
      assert.ok(r.payload.models.some(m => m.model_id === 'claude-account-two'))
      assert.equal(r.stderr, rejectedNotice('claude'))
      assert.equal(r.credentialsReads, 0)
      t.diagnostic(`selected ${selectedRejected ? 'rejected' : 'valid'}: printed ${r.payload.models.map(m => m.model_id).join(', ')}`)
    })
  }

  for (const selectedRejected of [false, true]) {
    test(`B5 skewed responses: ${selectedRejected ? 'T2 selected rejected' : 'T1 selected valid'}`, async t => {
      // Accounts one/two (a/b) reply after 300 ms; account three (c) returns 401 immediately.
      const r = await listing(t, { fleet: true, selectedRejected, goodDelayMs: 300, waitMs: 3000 })
      assert.ok(r.payload.models.some(m => m.model_id === newModel.id), 'new model must print after the good accounts settle')
      assert.ok(r.payload.models.some(m => m.model_id === 'claude-account-one'))
      assert.ok(r.payload.models.some(m => m.model_id === 'claude-account-two'))
      const before = JSON.parse(r.before), after = JSON.parse(r.after)
      const selected = selectedRejected ? 'three@fixture.test' : 'one@fixture.test'
      const snapshot = (store, key) => key === selected ? store.claude : store.accounts.claude[key]
      for (const key of ['one@fixture.test', 'two@fixture.test']) {
        assert.ok(snapshot(after, key).at > r.seededAt, `${key}: snapshot must be fresh`)
        assert.ok(snapshot(after, key).models.some(m => m.id === newModel.id))
      }
      assert.deepEqual(snapshot(after, 'three@fixture.test'), snapshot(before, 'three@fixture.test'))
      assert.deepEqual(r.calls.slice().sort(), ['Bearer fake-one@fixture.test', 'Bearer fake-two@fixture.test', 'Bearer fake-three@fixture.test'].sort())
      assert.equal(r.stderr, rejectedNotice('claude'))
      assert.equal(r.credentialsReads, 0)
    })
  }

  test('a late successful response after cancellation cannot overwrite the snapshot', async t => {
    const r = await listing(t, { behavior: 'delayed', lateResult: true, waitMs: 200 })
    assert.deepEqual(r.payload.models.map(m => m.model_id), [oldModel.id])
    assert.equal(r.after, r.before)
    assert.equal(r.calls.length, 1)
  })

  test('a hanging CLI-version registry is inside the same refresh deadline', async t => {
    const r = await listing(t, { registryHang: true, waitMs: 200 })
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
    for (const behavior of ['success', 'network', '401', '403', ...(provider === 'antigravity' ? ['502'] : [])]) {
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
          if (behavior === '401' || behavior === '403') assert.equal(r.stderr, rejectedNotice(provider).repeat(2))
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
