// Exercise the patched npm provider and standalone quota command with offline HTTP fixtures.
import assert from 'node:assert/strict'
import childProcess, { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire, register, syncBuiltinESMExports } from 'node:module'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = resolve(process.env.AHV_MODELS_TEST_PLUGIN
  ?? dirname(createRequire(new URL('../../../packages/bundle/ahv/package.json', import.meta.url)).resolve('dsh-plugin-subscriptions/package.json')))
const capture = process.env.AHV_AGY_CAPTURE
  ? JSON.parse(readFileSync(process.env.AHV_AGY_CAPTURE, 'utf8'))
  : undefined
const { old: oldCatalog, new: newCatalog } = capture
  ? { old: capture.old.resp, new: capture.new.resp }
  : JSON.parse(readFileSync(join(here, 'fixtures/antigravity-models.json'), 'utf8'))
const expectedModels = readFileSync(join(here, 'fixtures/agy-models-1.5.18.tsv'), 'utf8').trimEnd()
  .split('\n').map(line => line.split('\t'))
const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform]
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
const ua = version => `antigravity/cli/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=1030252320; auth_method=consumer)`
const session = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', projectId: '<PROJECT>' }
const oauth = { clientId: 'fixture-client' }
const oauthResponse = { access_token: 'fixture-next', refresh_token: 'fixture-next-refresh', expires_in: 3600 }

register('./helpers/subscriptions-loader.mjs', import.meta.url)
Socket.prototype.connect = function () { throw new Error('unexpected network socket') }
globalThis.fetch = async () => { throw new Error('unexpected fetch') }

const provider = await import(pathToFileURL(join(plugin, 'lib/providers/antigravity.js')).href)

function fixtureHttp(catalog = newCatalog) {
  const requests = []
  const completion = { response: { candidates: [{ content: { parts: [{ text: 'fixture reply' }] }, finishReason: 'STOP' }] } }
  const fetchFn = async (url, init) => {
    const { host, pathname } = new URL(url)
    const method = pathname.replace(/^\/v1internal:/, '')
    const headers = new Headers(init.headers)
    requests.push({ host, method, ua: headers.get('user-agent'), body: headers.get('content-type') === 'application/json' ? JSON.parse(init.body) : undefined })
    switch (method) {
      case 'fetchAvailableModels': return Response.json(catalog)
      case 'generateContent': return Response.json(completion)
      case 'streamGenerateContent': return new Response(`data: ${JSON.stringify(completion)}\n\n`)
      case 'retrieveUserQuotaSummary': return Response.json({ groups: [] })
      case 'loadCodeAssist': return Response.json({ allowedTiers: [{ id: 'fixture-tier', isDefault: true }] })
      case 'onboardUser': return Response.json({ done: true, response: { cloudaicompanionProject: '<PROJECT>' } })
      case '/oauth2/v2/userinfo': return Response.json({ email: 'fixture@example.test' })
      case '/token': return Response.json(oauthResponse)
      default: throw new Error(`Unexpected fixture endpoint ${url}`)
    }
  }
  return { requests, fetchFn }
}

function adapter(runtime, fetchFn) {
  return new provider.AntigravityAdapter({
    tokens: { session: async () => session },
    models: [], discovery: false, runtime, fetchFn,
  })
}

function prompt(model, reasoningEffort) {
  return {
    provider: 'antigravity', model, reasoningEffort,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    signal: new AbortController().signal,
  }
}

async function exerciseEndpoints(runtime, onModelsRequest) {
  const { requests, fetchFn } = fixtureHttp()
  const ag = adapter(runtime, fetchFn)
  await provider.fetchAntigravityModels(session, runtime, (...args) => {
    onModelsRequest?.()
    return fetchFn(...args)
  })
  await ag.generate(prompt('gemini-4-carbon-high'))
  for await (const _part of ag.stream(prompt('gemini-4-carbon-high'))) { /* drain the SSE stream */ }
  await provider.fetchAntigravityUsage(session, runtime, fetchFn)
  await provider.exchangeAntigravityCode('fixture-code', 'fixture-verifier', 'http://localhost:51121/oauth-callback', oauth, runtime, fetchFn)
  await provider.refreshAntigravity(session, oauth, fetchFn)
  const bot = await import('../ahv-bot.mjs')
  await bot.fetchProviderUsage('antigravity', session, fetchFn)
  return requests
}

if (process.argv.includes('--probe')) {
  // A probe of another account's agy would run as this user; the alternate
  // fixture stands in for that executable and must stay unused.
  const probe = promisify(childProcess.execFile)
  childProcess.execFile = Object.assign(() => { throw new Error('unexpected callback-based executable probe') }, {
    [promisify.custom]: (file, ...args) => {
      if (file !== '/home/agyproxy/.local/bin/agy') return probe(file, ...args)
      const alternate = process.env.AHV_AGY_TEST_ALTERNATE
      if (alternate) return probe(alternate, ...args)
      return Promise.reject(Object.assign(new Error('fixture executable missing'), { code: 'ENOENT' }))
    },
  })
  syncBuiltinESMExports()
  let eventLoopTurn = false
  let timerRanBeforeModelsRequest
  const timer = setTimeout(() => { eventLoopTurn = true }, 30)
  const requests = await exerciseEndpoints({}, () => { timerRanBeforeModelsRequest = eventLoopTurn })
  clearTimeout(timer)
  process.stdout.write(JSON.stringify({ requests, timerRanBeforeModelsRequest }))
} else {
  function probe(t, output, { hang = false, alternate = false } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'ahv-agy-'))
    t.after(() => rmSync(home, { recursive: true, force: true }))
    const bin = join(home, 'bin')
    const marker = join(home, 'probes')
    const packageParent = join(home, 'fork/packages/bundle/ahv/node_modules')
    mkdirSync(bin)
    mkdirSync(packageParent, { recursive: true })
    symlinkSync(plugin, join(packageParent, 'dsh-plugin-subscriptions'), 'junction')
    if (output !== undefined) {
      writeFileSync(join(alternate ? home : bin, 'agy'), `#!${process.execPath}\n` +
        `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + '\\n');\n` +
        (hang ? 'setInterval(() => {}, 1000);' : `process.stdout.write(${JSON.stringify(output)});\n`), { mode: 0o700 })
    }
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--probe'], {
      env: { PATH: bin, HOME: home, AHV_FORK: join(home, 'fork'), AHV_MODELS_TEST_PLUGIN: plugin,
        ...(alternate ? { AHV_AGY_TEST_ALTERNATE: join(home, 'agy') } : {}) },
      encoding: 'utf8', timeout: 5000,
    })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.equal(result.stderr, '')
    return { ...JSON.parse(result.stdout), marker }
  }

  test('all Antigravity internal methods send the complete pinned UA if agy is absent', t => {
    const { requests } = probe(t)
    const internal = requests.filter(({ host }) => host === 'daily-cloudcode-pa.googleapis.com')
    assert.deepEqual(internal.map(({ method }) => method), [
      'fetchAvailableModels', 'generateContent', 'streamGenerateContent',
      'fetchAvailableModels', 'loadCodeAssist', 'loadCodeAssist', 'onboardUser', 'retrieveUserQuotaSummary',
    ])
    for (const { method, ua: actual } of internal) assert.equal(actual, ua('1.5.18'), method)
    const tokens = requests.filter(({ host }) => host === 'oauth2.googleapis.com')
    assert.equal(tokens.length, 2)
    assert.ok(tokens.every(({ ua }) => ua === null))
    t.diagnostic(internal[0].ua)
  })

  test('local agy version is used for models, generation and quota with a single probe', t => {
    const { requests, marker } = probe(t, 'agy 2.4.6\n')
    assert.equal(readFileSync(marker, 'utf8'), '--version\n')
    for (const { method, ua: actual } of requests.filter(r => r.host === 'daily-cloudcode-pa.googleapis.com')) {
      assert.equal(actual, ua('2.4.6'), method)
    }
  })

  test('agy outside PATH is never executed', t => {
    const { requests, marker } = probe(t, '1.6.2\n', { alternate: true })
    assert.equal(existsSync(marker), false)
    assert.equal(requests[0].ua, ua('1.5.18'))
  })

  for (const [name, output, flags] of [
    ['garbage', 'build unavailable / 1.2.3.4\n'],
    ['timeout', '', { hang: true }],
  ]) {
    test(`agy ${name} falls back to the pinned version and remembers the failure`, t => {
      const { requests, marker, timerRanBeforeModelsRequest } = probe(t, output, flags)
      assert.equal(readFileSync(marker, 'utf8'), '--version\n')
      assert.equal(requests[0].ua, ua('1.5.18'))
      if (flags?.hang) assert.equal(timerRanBeforeModelsRequest, true, 'version probe must not block the event loop')
    })
  }

  test('antigravity.userAgent overrides the UA on all plugin internal methods', async () => {
    const requests = await exerciseEndpoints({ userAgent: 'fixture/override' })
    for (const { method, ua: actual } of requests.filter(r => r.host === 'daily-cloudcode-pa.googleapis.com' && r.method !== 'retrieveUserQuotaSummary')) {
      assert.equal(actual, 'fixture/override', method)
    }
  })

  async function list(catalog) {
    const { fetchFn } = fixtureHttp(catalog)
    return (await provider.fetchAntigravityModels(session, { userAgent: 'fixture/override' }, fetchFn)).map(({ id, name }) => [id, name])
  }

  test('captured new catalog lists precisely the 27 agy models, names and order', async () => {
    assert.equal(expectedModels.length, 27)
    assert.deepEqual(await list(newCatalog), expectedModels)
  })

  test('catalog order spans all sort groups and each id appears once', async () => {
    const [a, b, c] = expectedModels
    const group = (...ids) => ({ modelIds: ids })
    assert.deepEqual(await list({
      ...newCatalog,
      agentModelSorts: [{ groups: [group(b[0], a[0]), group(b[0])] }, { groups: [group(c[0], a[0])] }],
    }), [b, a, c])
  })

  test('catalog without sort groups hides internal, tab, chat and media-only models', async () => {
    const { agentModelSorts: _sorts, ...fallback } = newCatalog
    const models = { ...fallback.models,
      'chat_fixture': { displayName: 'Internal chat' },
      'internal-fixture': { isInternal: true },
      'fixture-transcriber': { displayName: 'Transcriber' },
      'fixture-audio-only': { inputModalities: ['audio'], outputModalities: ['text'] },
      'fixture-image-only': { outputModalities: ['image'] },
      'fixture-multimodal-chat': { inputModalities: ['text', 'image'], outputModalities: ['text'] },
    }
    const ids = (await list({
      ...fallback, models,
      audioTranscriptionModelIds: [...fallback.audioTranscriptionModelIds, 'fixture-transcriber'],
    })).map(([id]) => id)
    for (const id of ids) assert.doesNotMatch(id, /^(tab|chat)_/)
    for (const excluded of ['internal-fixture', 'fixture-transcriber', 'fixture-audio-only', 'fixture-image-only', 'gemini-3.1-flash-image']) {
      assert.ok(!ids.includes(excluded), excluded)
    }
    assert.ok(ids.includes('fixture-multimodal-chat'))
    assert.ok(ids.includes('gemini-4-carbon-high'))
  })

  test('captured old catalog still returns models', async () => {
    assert.ok((await list(oldCatalog)).length > 0)
  })

  for (const [id, level, effort] of [
    ['gemini-4-carbon-low', 'LOW'],
    ['gemini-3.8-flash-medium', 'MEDIUM'],
    ['gemini-4-carbon-high', 'HIGH'],
    ['gemini-4-neon-xhigh', 'XHIGH'],
    ['claude-sonnet-5-5-low', 'LOW', 'high'],
    ['gpt-oss-120b-medium', 'MEDIUM'],
    ['gemini-pro-orchestrator', undefined],
    ['gpt-oss-120b', undefined, 'medium'],
    ['gemini-4-hydrogen-sonar', undefined],
  ]) {
    test(`generation preserves ${id} and its thinking level on both transports`, async () => {
      const { requests, fetchFn } = fixtureHttp()
      const ag = adapter({ userAgent: 'fixture/override' }, fetchFn)
      await ag.generate(prompt(id, effort))
      for await (const _part of ag.stream(prompt(id, effort))) { /* drain the SSE stream */ }
      assert.deepEqual(requests.map(r => r.method), ['generateContent', 'streamGenerateContent'])
      for (const { body } of requests) {
        assert.equal(body.model, id)
        const thinking = body.request.generationConfig?.thinkingConfig
        if (level === undefined) assert.equal(thinking?.thinkingLevel, undefined)
        else assert.deepEqual(thinking, { includeThoughts: true, thinkingLevel: level })
      }
    })
  }
}
