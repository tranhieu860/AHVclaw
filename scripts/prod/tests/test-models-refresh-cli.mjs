// Real ahv-bot CLI/spawn/output path; the profile launcher is replaced offline.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const plugin = process.env.AHV_MODELS_TEST_PLUGIN
assert.ok(plugin, 'set AHV_MODELS_TEST_PLUGIN to the patched 0.9.12 fixture')
const bot = process.env.AHV_MODELS_TEST_BOT ?? join(root, 'scripts/prod/ahv-bot.mjs')

function command(t, { fresh = false, behavior, waitMs = 200 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ahv-1280-cli-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const dshHome = join(home, '.dsh'), fork = join(home, 'fork')
  const store = join(dshHome, 'plugins/subscriptions')
  for (const path of [store, join(fork, 'node_modules/tsx'), join(fork, 'apps/cli/src')]) mkdirSync(path, { recursive: true })
  writeFileSync(join(store, 'auth.json'), JSON.stringify({ claude: { default: 'one@fixture.test', accounts: {
    'one@fixture.test': { accessToken: 'fake-one@fixture.test', refreshToken: 'fake-refresh', expiresAt: Date.now() + 86_400_000, emailAddress: 'one@fixture.test' },
  } } }), { mode: 0o600 })
  const seededAt = Date.now() - (fresh ? 600_000 : 7_200_000)
  const before = JSON.stringify({ claude: { at: seededAt, models: [{ id: 'claude-old', name: 'Old Claude' }] } }, null, 3) + '\n'
  writeFileSync(join(store, 'models.json'), before)
  writeFileSync(join(fork, 'node_modules/tsx/package.json'), JSON.stringify({ type: 'module', exports: { './esm': './index.mjs' } }))
  writeFileSync(join(fork, 'node_modules/tsx/index.mjs'), `import ${JSON.stringify(pathToFileURL(join(here, 'helpers/subscriptions-register.mjs')).href)}\n`)
  writeFileSync(join(fork, 'apps/cli/src/bin.ts'), `
    process.env.AHV_MODELS_TEST_WORKER = '1'
    process.env.AHV_MODELS_TEST_CASE = JSON.stringify({ ...JSON.parse(process.env.AHV_MODELS_TEST_CASE), legacy: process.env.AHV_MODELS_LIST_ONESHOT !== '1' })
    await import(${JSON.stringify(pathToFileURL(join(here, 'test-models-refresh.mjs')).href)})
  `)
  const start = performance.now()
  const result = spawnSync(process.execPath, [bot, 'models', 'list', '--json'], {
    env: { PATH: process.env.PATH, HOME: home, DSH_HOME: dshHome, AHV_FORK: fork,
      AHV_MODELS_TEST_PLUGIN: plugin, AHV_MODELS_TEST_CASE: JSON.stringify({ behavior }),
      ...(waitMs === null ? {} : { AHV_MODELS_REFRESH_WAIT_MS: String(waitMs) }) },
    encoding: 'utf8', timeout: waitMs === null ? 14_000 : 5000,
  })
  const elapsedMs = performance.now() - start
  assert.equal(result.status, 0, `${result.error ?? ''} ${result.stderr}`)
  const payload = JSON.parse(result.stdout)
  assert.equal(result.stdout, JSON.stringify(payload) + '\n')
  assert.equal(payload.source, 'harness', JSON.stringify(payload))
  return { payload, before, after: readFileSync(join(store, 'models.json'), 'utf8'), seededAt, elapsedMs }
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
    assert.ok(r.elapsedMs < 1500)
    if (behavior === 'hang') t.diagnostic(`real CLI with offline launcher, 200 ms budget: ${r.elapsedMs.toFixed(1)} ms`)
  })
}

test('CLI fresh snapshot timing with the offline launcher', t => {
  const r = command(t, { fresh: true, behavior: 'hang' })
  assert.equal(r.after, r.before)
  assert.ok(r.elapsedMs < 1500)
  t.diagnostic(`real CLI with offline launcher, fresh snapshot: ${r.elapsedMs.toFixed(1)} ms`)
})

test('CLI default deadline is 8000 ms when the setting is absent', t => {
  const r = command(t, { behavior: 'hang', waitMs: null })
  assert.equal(r.after, r.before)
  assert.ok(r.elapsedMs >= 8_000 && r.elapsedMs < 10_000, `unexpected default wait ${r.elapsedMs}`)
  t.diagnostic(`real CLI with offline launcher, default budget: ${r.elapsedMs.toFixed(1)} ms`)
})
