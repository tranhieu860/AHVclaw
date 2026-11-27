// Real ahv-bot CLI/spawn/output path; the profile launcher is replaced offline.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const plugin = process.env.AHV_MODELS_TEST_PLUGIN
assert.ok(plugin, 'set AHV_MODELS_TEST_PLUGIN to the patched 0.9.12 fixture')
// A hang that ignores abort ends at the 5 s spawn timeout; anything below this proves the deadline ended it.
const HANG_BOUND_MS = 4000
const bot = process.env.AHV_MODELS_TEST_BOT ?? join(root, 'scripts/prod/ahv-bot.mjs')

function command(t, { fresh = false, behavior, waitMs = 200, merge = false, agyCapture } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ahv-1280-cli-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const dshHome = join(home, '.dsh'), fork = join(home, 'fork')
  const store = join(dshHome, 'plugins/subscriptions')
  for (const path of [store, join(fork, 'node_modules/tsx'), join(fork, 'apps/cli/src')]) mkdirSync(path, { recursive: true })
  const provider = agyCapture ? 'antigravity' : 'claude'
  writeFileSync(join(store, 'auth.json'), JSON.stringify({ [provider]: { default: 'one@fixture.test', accounts: {
    'one@fixture.test': { accessToken: 'fake-one@fixture.test', refreshToken: 'fake-refresh', expiresAt: Date.now() + 86_400_000, emailAddress: 'one@fixture.test',
      ...(agyCapture ? { account: 'one@fixture.test', projectId: '<PROJECT>' } : {}) },
  } } }), { mode: 0o600 })
  const seededAt = Date.now() - (fresh ? 600_000 : 7_200_000)
  const oldModel = agyCapture ? { id: 'gemini-old', name: 'Old Gemini' } : { id: 'claude-old', name: 'Old Claude' }
  const before = JSON.stringify({ [provider]: { at: seededAt, models: [oldModel] } }, null, 3) + '\n'
  writeFileSync(join(store, 'models.json'), before)
  writeFileSync(join(fork, 'node_modules/tsx/package.json'), JSON.stringify({ type: 'module', exports: { './esm': './index.mjs' } }))
  writeFileSync(join(fork, 'node_modules/tsx/index.mjs'), `import ${JSON.stringify(pathToFileURL(join(here, 'helpers/subscriptions-register.mjs')).href)}\n`)
  writeFileSync(join(fork, 'apps/cli/src/bin.ts'), `
    process.env.AHV_MODELS_TEST_WORKER = '1'
    process.env.AHV_MODELS_TEST_CASE = JSON.stringify({ ...JSON.parse(process.env.AHV_MODELS_TEST_CASE), legacy: process.env.AHV_MODELS_LIST_ONESHOT !== '1' })
    await import(${JSON.stringify(pathToFileURL(join(here, 'test-models-refresh.mjs')).href)})
  `)
  const diagnosticFile = join(home, 'diagnostic.json')
  const start = performance.now()
  // merge reproduces bot.py run_ahv_json_command: stderr folded into stdout, then one json.loads.
  const modelsArgs = ['models', 'list', '--json']
  let argv = [process.execPath, bot, ...modelsArgs]
  let path = process.env.PATH
  if (agyCapture) {
    const wrapper = join(home, 'ahv')
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'agy'), `#!${process.execPath}\nprocess.stdout.write('1.5.18\\n')\n`, { mode: 0o700 })
    path = [bin, path].filter(Boolean).join(delimiter)
    writeFileSync(wrapper, readFileSync(join(root, 'scripts/prod/ahv-wrapper.sh'), 'utf8').replace('__AHV_SRC__', fork), { mode: 0o700 })
    writeFileSync(join(home, 'ahv-bot.mjs'), readFileSync(bot))
    argv = [wrapper, ...modelsArgs]
  }
  if (merge) argv = ['sh', '-c', 'exec "$0" "$@" 2>&1', ...argv]
  const [file, ...args] = argv
  const result = spawnSync(file, args, {
    env: { PATH: path, HOME: home, DSH_HOME: dshHome, AHV_FORK: fork,
      AHV_MODELS_TEST_PLUGIN: plugin, AHV_MODELS_TEST_CASE: JSON.stringify({ behavior, provider, agyCapture }),
      AHV_MODELS_TEST_DIAGNOSTIC_FILE: diagnosticFile,
      ...(waitMs === null ? {} : { AHV_MODELS_REFRESH_WAIT_MS: String(waitMs) }) },
    encoding: 'utf8', timeout: waitMs === null ? 60_000 : 5000,
  })
  const elapsedMs = performance.now() - start
  assert.equal(result.status, 0, `${result.error ?? ''} ${result.stderr}`)
  const payload = JSON.parse(result.stdout)
  assert.equal(result.stdout, JSON.stringify(payload) + '\n')
  assert.equal(result.stderr, '', 'exit 0 must leave stderr empty: older bots merge it into the JSON')
  assert.equal(payload.source, 'harness', JSON.stringify(payload))
  return { payload, before, after: readFileSync(join(store, 'models.json'), 'utf8'), seededAt, elapsedMs, stderr: result.stderr, diagnosticFile }
}

test('CLI stale snapshot: spawn opts into bounded refresh and prints the new model', t => {
  const r = command(t)
  assert.ok(r.payload.models.some(m => m.id === 'claude-fable-5-2'))
  assert.ok(JSON.parse(r.after).claude.at > r.seededAt)
})

for (const behavior of ['hang', 'network', '401', 'abort']) {
  test(`CLI ${behavior}: old catalog, identical bytes, one JSON, exit 0`, t => {
    const r = command(t, { behavior })
    assert.ok(r.payload.models.some(m => m.id === 'claude-old'))
    assert.equal(r.after, r.before)
    assert.ok(r.elapsedMs < HANG_BOUND_MS, `unbounded wait: ${r.elapsedMs}`)
    if (behavior === 'hang') t.diagnostic(`real CLI with offline launcher, 200 ms budget: ${r.elapsedMs.toFixed(1)} ms`)
  })
}

test('CLI 401: the rejected-token notice is a JSON warning that survives stderr→stdout merging', t => {
  const r = command(t, { behavior: '401', merge: true })
  assert.ok(r.payload.models.some(m => m.id === 'claude-old'))
  assert.equal(r.payload.warnings.length, 1, JSON.stringify(r.payload.warnings))
  assert.match(r.payload.warnings[0], /subscriptions: claude: token bị từ chối/)
  assert.doesNotMatch(r.payload.warnings.join('\n'), /fake-|\/tmp\/|\/home\//)
})

test('CLI without a provider problem: no warnings field', t => {
  const r = command(t, { behavior: 'network' })
  assert.equal(r.payload.warnings, undefined)
})

test('CLI fresh snapshot timing with the offline launcher', t => {
  const r = command(t, { fresh: true, behavior: 'hang' })
  assert.equal(r.after, r.before)
  assert.ok(r.elapsedMs < HANG_BOUND_MS, `unbounded wait: ${r.elapsedMs}`)
  t.diagnostic(`real CLI with offline launcher, fresh snapshot: ${r.elapsedMs.toFixed(1)} ms`)
})

test('CLI default deadline is 8000 ms when the setting is absent', t => {
  const r = command(t, { behavior: 'hang', waitMs: null })
  assert.equal(r.after, r.before)
  // The deadline starts before the first fetch, so the abort comes at most 8000 ms (plus timer lateness) after it, whatever the
  // load; the whole command can never finish before the deadline. Process start-up delay therefore counts only on the lower side.
  const { abortAfterMs } = JSON.parse(readFileSync(r.diagnosticFile, 'utf8'))
  assert.equal(abortAfterMs.length, 1, `abort times ${abortAfterMs}`)
  assert.ok(abortAfterMs[0] < 8_600, `deadline longer than 8000 ms: abort ${abortAfterMs[0]} ms after the first fetch`)
  assert.ok(r.elapsedMs >= 8_000, `deadline shorter than 8000 ms: command took ${r.elapsedMs}`)
  t.diagnostic(`real CLI with offline launcher, default budget: abort ${abortAfterMs[0].toFixed(1)} ms after the first fetch, whole command ${r.elapsedMs.toFixed(1)} ms`)
})

test('CLI models show survives a spawn error of the dsh child (exit 0, one JSON line, empty stderr)', t => {
  const home = mkdtempSync(join(tmpdir(), 'ahv-1209-show-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const fork = join(home, 'fork')
  mkdirSync(join(fork, 'packages/bundle/ahv'), { recursive: true })
  mkdirSync(join(home, '.ahv'), { recursive: true })
  writeFileSync(join(fork, 'packages/bundle/ahv/cordis.patch.yml'), readFileSync(join(root, 'packages/bundle/ahv/cordis.patch.yml')))
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(here, 'helpers/spawn-error-preload.mjs')).href, bot, 'models', 'show', 'AHV-Holding', '--json'], {
    env: { PATH: process.env.PATH, HOME: home, AHV_FORK: fork }, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 0, `${result.error ?? ''} ${result.stderr}`)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.trim().split('\n').length, 1)
  assert.equal(JSON.parse(result.stdout).id, 'AHV-Holding')
})

test('ahv models list --json prints the captured 27 Antigravity ids and names in agy order', t => {
  const { payload, after } = command(t, {
    waitMs: 3000,
    agyCapture: process.env.AHV_AGY_CAPTURE ?? join(here, 'fixtures/antigravity-models.json'),
  })
  const expected = readFileSync(join(here, 'fixtures/agy-models-1.5.18.tsv'), 'utf8').trimEnd()
    .split('\n').map(line => line.split('\t'))
  const models = payload.models.filter(model => model.provider === 'antigravity')
  assert.equal(models.length, 27)
  assert.deepEqual(models.map(({ id, name }) => [id, name]), expected)
  assert.equal(JSON.parse(after).antigravity.models.length, 27)
  t.diagnostic('ahv models list --json: antigravity=27, source=harness, exit=0')
})
