// The console must show how far the AHV CLI core is behind upstream.
//
// 29/09/2026: the fleet ran dsh 0.1.1-rc.1 (21/08) while upstream had shipped
// 0.1.7-rc.2 and 0.2.0-rc.1; nothing said so until a plugin written for the new
// core broke every `ahv run`.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const lag = await import(new URL('../ahv-admin-core-lag.mjs', import.meta.url).href)
let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++ }
}
// Shaped like GitHub's releases API for deepseek-ai/deepseek-harness.
const RAW = [
  { tag_name: 'dsh-v0.2.0-rc.1', published_at: '2026-09-28T12:36:21Z', prerelease: true },
  { tag_name: 'dsh-v0.1.7-rc.2', published_at: '2026-09-24T14:10:21Z', prerelease: true },
  { tag_name: 'dsh-v0.1.7-alpha.2', published_at: '2026-09-22T15:49:49Z', prerelease: true },
  { tag_name: 'dsh-v0.1.5-rc.1', published_at: '2026-09-10T08:00:00Z', prerelease: true },
  { tag_name: 'dsh-v0.1.2-rc.1', published_at: '2026-08-27T08:00:00Z', prerelease: true },
  { tag_name: 'dsh-v0.1.1-rc.1', published_at: '2026-08-21T08:00:00Z', prerelease: true },
  { tag_name: 'dsh-v9.9.9', published_at: '2026-09-29T00:00:00Z', draft: true },
  { tag_name: 'not-a-version', published_at: '2026-09-29T00:00:00Z' },
]
const NOW = Date.parse('2026-09-29T05:00:00Z')

await check('orders versions like SemVer (rc before release, alpha before rc)', () => {
  assert.ok(lag.compareVersions('0.2.0-rc.1', '0.1.7-rc.2') > 0)
  assert.ok(lag.compareVersions('0.2.0', '0.2.0-rc.1') > 0)
  assert.ok(lag.compareVersions('0.1.7-rc.1', '0.1.7-alpha.2') > 0)
  assert.equal(lag.compareVersions('0.1.10-rc.1', '0.1.9-rc.1') > 0, true)
})
await check('tracks rc and releases, skips alphas, drafts and junk', () => {
  const versions = lag.trackedReleases(RAW).map(r => r.version)
  assert.deepEqual(versions, ['0.2.0-rc.1', '0.1.7-rc.2', '0.1.5-rc.1', '0.1.2-rc.1', '0.1.1-rc.1'])
})
await check('the 29/09 state: 0.1.1-rc.1 is 32 days behind, warned', () => {
  const r = lag.coreLag('0.1.1-rc.1', lag.trackedReleases(RAW), NOW)
  assert.equal(r.latest, '0.2.0-rc.1')
  assert.equal(r.since, '0.1.2-rc.1')
  assert.equal(r.behind, 4)
  assert.equal(r.days, 32)
  assert.equal(r.warn, true)
})
await check('on the latest core: 0 days, no warning', () => {
  const r = lag.coreLag('0.2.0-rc.1', lag.trackedReleases(RAW), NOW)
  assert.deepEqual([r.days, r.behind, r.warn], [0, 0, false])
})
await check('a gap younger than 14 days is shown but not warned', () => {
  const r = lag.coreLag('0.1.7-rc.2', lag.trackedReleases(RAW), NOW)
  assert.deepEqual([r.days, r.warn, r.since], [0, false, '0.2.0-rc.1'])
  const later = lag.coreLag('0.1.7-rc.2', lag.trackedReleases(RAW), Date.parse('2026-10-13T13:00:00Z'))
  assert.deepEqual([later.days, later.warn], [15, true])
})
await check('refresh reads each channel tag from the fork and stores the report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'corelag-'))
  const channels = join(dir, 'channels.json')
  const fork = new URL('../../..', import.meta.url).pathname
  const { writeFileSync } = await import('node:fs')
  writeFileSync(channels, JSON.stringify({ stable: 'v0.2.49', canary: 'v0.2.51' }))
  const fetchImpl = async () => ({ ok: true, json: async () => RAW })
  const report = await lag.refreshCoreLag({ fork, channelsPath: channels, cachePath: join(dir, 'lag.json'), fetchImpl, now: NOW })
  assert.equal(report.channels.stable.core, '0.1.1-rc.1')
  assert.equal(report.channels.stable.warn, true)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'lag.json'), 'utf8')).channels.stable.tag, 'v0.2.49')
})
await check('the view follows a promote without refetching GitHub', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'corelag-'))
  const { writeFileSync } = await import('node:fs')
  const channels = join(dir, 'channels.json'); const cache = join(dir, 'lag.json')
  const fork = new URL('../../..', import.meta.url).pathname
  writeFileSync(channels, JSON.stringify({ stable: 'v0.2.49', canary: 'v0.2.49' }))
  let calls = 0
  await lag.refreshCoreLag({ fork, channelsPath: channels, cachePath: cache, fetchImpl: async () => { calls++; return { ok: true, json: async () => RAW } }, now: NOW })
  writeFileSync(channels, JSON.stringify({ stable: 'v0.2.49', canary: 'v0.2.51' }))
  const view = lag.readCoreLag({ fork, channelsPath: channels, cachePath: cache, now: NOW })
  assert.equal(calls, 1)
  assert.equal(view.channels.canary.tag, 'v0.2.51')
  assert.equal(view.checked_at, new Date(NOW).toISOString())
  assert.equal(lag.readCoreLag({ fork, channelsPath: channels, cachePath: join(dir, 'missing'), now: NOW }).checked_at, null)
})
await check('an unknown tag reports no core instead of throwing', async () => {
  assert.equal(lag.dshVersionAtTag('/nonexistent', 'v0.2.49'), null)
  assert.equal(lag.dshVersionAtTag('/nonexistent', '; rm -rf /'), null)
})
await check('a GitHub error surfaces instead of storing an empty report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'corelag-'))
  await assert.rejects(lag.refreshCoreLag({ fork: '/x', channelsPath: join(dir, 'c'), cachePath: join(dir, 'l'), fetchImpl: async () => ({ ok: false, status: 403 }) }), /403/)
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
