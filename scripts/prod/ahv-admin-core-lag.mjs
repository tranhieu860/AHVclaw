// How far the AHV CLI core (dsh) is behind upstream — read-only, never merges.
//
// On 29/09/2026 the fleet still ran dsh 0.1.1-rc.1 (from 21/08) while upstream
// had shipped 0.1.7-rc.2 and 0.2.0-rc.1; plugins pinned by the registry sync
// were already written for the newer core and v0.2.50 broke `ahv run`. Nothing
// showed the gap. The admin console now shows "lõi dsh X — upstream mới nhất Y
// (tụt N ngày)" and warns past LAG_WARN_DAYS. Upgrading stays a manual,
// reviewed merge (PULLING_UPSTREAM.md).
//
// Deployed beside server.mjs in /opt/ahv-admin; the source of truth is the
// fork's scripts/prod/ahv-admin-core-lag.mjs.
import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export const UPSTREAM_RELEASES_URL = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100'
export const LAG_WARN_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

/** Parse "0.2.0-rc.1" / "dsh-v0.2.0-rc.1" into comparable parts, or null. */
export function parseVersion(value) {
  const match = /^(?:dsh-v)?(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/.exec(String(value ?? '').trim())
  if (!match) return null
  const rank = { alpha: 0, beta: 1, rc: 2 }
  return {
    text: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}.${match[5]}` : ''}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3]),
      match[4] === undefined ? 9 : (rank[match[4]] ?? -1), match[5] === undefined ? 0 : Number(match[5])],
    channel: match[4] ?? 'release',
  }
}

/** Negative when a < b, positive when a > b (SemVer order, a release after its prereleases). */
export function compareVersions(a, b) {
  const x = parseVersion(a)?.parts ?? []
  const y = parseVersion(b)?.parts ?? []
  for (let i = 0; i < 5; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Upstream releases worth tracking: release candidates and releases.
 * Alphas are upstream's own previews and would make the console cry wolf daily.
 * @param {Array<{tag_name: string, published_at: string, draft?: boolean}>} raw - GitHub releases.
 * @returns {Array<{version: string, tag: string, publishedAt: string}>} newest first.
 */
export function trackedReleases(raw) {
  const out = []
  for (const release of Array.isArray(raw) ? raw : []) {
    if (release?.draft) continue
    const parsed = parseVersion(release?.tag_name)
    if (!parsed || parsed.channel === 'alpha' || parsed.channel === 'beta') continue
    if (!release.published_at || Number.isNaN(Date.parse(release.published_at))) continue
    out.push({ version: parsed.text, tag: release.tag_name, publishedAt: release.published_at })
  }
  return out.sort((a, b) => compareVersions(b.version, a.version))
}

/**
 * The gap between one core version and upstream.
 * `days` counts from the first upstream release newer than the core: that is
 * how long a newer core has existed without us taking it.
 * @param {string} core - dsh version the release runs (e.g. "0.1.1-rc.1").
 * @param {Array<{version: string, publishedAt: string}>} releases - from trackedReleases().
 * @param {number} now - epoch ms.
 */
export function coreLag(core, releases, now) {
  const latest = releases[0] ?? null
  const newer = releases.filter(r => compareVersions(r.version, core) > 0)
  if (!latest || newer.length === 0) {
    return { core, latest: latest?.version ?? null, latestAt: latest?.publishedAt ?? null, behind: 0, days: 0, since: null, warn: false }
  }
  const since = newer.reduce((first, r) => (Date.parse(r.publishedAt) < Date.parse(first.publishedAt) ? r : first))
  const days = Math.max(0, Math.floor((now - Date.parse(since.publishedAt)) / DAY_MS))
  return {
    core, latest: latest.version, latestAt: latest.publishedAt, behind: newer.length,
    days, since: since.version, warn: days > LAG_WARN_DAYS,
  }
}

/** dsh version a fork tag ships (apps/cli/package.json at that tag), or null. */
export function dshVersionAtTag(fork, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(String(tag ?? ''))) return null
  try {
    const text = execFileSync('git', ['-C', fork, 'show', `${tag}:apps/cli/package.json`], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
    const version = JSON.parse(text).version
    return parseVersion(version) ? version : null
  } catch {
    return null
  }
}

/**
 * The report for the channels as they are now, from already-fetched releases.
 * Cheap (two `git show`), so the console recomputes it on every view: a
 * promote changes what stable runs long before the next daily fetch.
 */
export function coreLagReport({ fork, channelsPath, releases, checkedAt, now = Date.now() }) {
  let channels = {}
  try { channels = JSON.parse(readFileSync(channelsPath, 'utf8')) } catch {}
  const report = { checked_at: checkedAt ?? null, warn_days: LAG_WARN_DAYS, latest: releases[0] ?? null, channels: {} }
  for (const name of ['stable', 'canary']) {
    const tag = channels[name]
    const core = dshVersionAtTag(fork, tag)
    report.channels[name] = core ? { tag, ...coreLag(core, releases, now) } : { tag: tag ?? null, core: null }
  }
  return report
}

/**
 * Fetch upstream releases (once a day is plenty) and store them with a report.
 * @returns {Promise<object>} the report written to `cachePath`.
 */
export async function refreshCoreLag({ fork, channelsPath, cachePath, fetchImpl = fetch, now = Date.now() }) {
  const response = await fetchImpl(UPSTREAM_RELEASES_URL, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'ahv-admin-core-lag' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GitHub releases HTTP ${response.status}`)
  const releases = trackedReleases(await response.json())
  const checkedAt = new Date(now).toISOString()
  const report = coreLagReport({ fork, channelsPath, releases, checkedAt, now })
  const tmp = `${cachePath}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...report, releases }, null, 2) + '\n', { mode: 0o644 })
  renameSync(tmp, cachePath)
  return report
}

/** What the console serves: the stored releases, re-read against today's channels. */
export function readCoreLag({ fork, channelsPath, cachePath, now = Date.now() }) {
  let cached
  try { cached = JSON.parse(readFileSync(cachePath, 'utf8')) } catch { return { checked_at: null, channels: {}, latest: null, warn_days: LAG_WARN_DAYS } }
  return coreLagReport({ fork, channelsPath, releases: Array.isArray(cached.releases) ? cached.releases : [], checkedAt: cached.checked_at, now })
}
