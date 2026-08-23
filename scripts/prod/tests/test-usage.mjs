// Real subscription quota, not a placeholder.
//
// The admin console showed zeros for Codex and Grok because the only usage it
// had was parsed from local CLI logs, which do not exist for accounts logged in
// under other service users. The providers themselves report the remaining
// quota; this reads it with the stored OAuth token and normalises the three
// different payload shapes into one.
import assert from 'node:assert/strict'

const { normaliseUsagePayload, USAGE_ENDPOINTS, fetchProviderUsage } =
  await import('/home/claudeproxy/Claude/AHVclaw-fork/scripts/prod/ahv-bot.mjs')

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++ }
}
async function acheck(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++ }
}

check('every provider has an endpoint', () => {
  for (const k of ['claude', 'codex', 'grok']) assert.ok(USAGE_ENDPOINTS[k]?.url, k)
})

check('claude modern limits become windows', () => {
  const out = normaliseUsagePayload('claude', {
    limits: [
      { kind: 'session', percent: 42, resets_at: '2026-08-24T05:00:00Z' },
      { kind: 'weekly_all', percent: 8 },
    ],
  })
  assert.equal(out.supported, true)
  assert.equal(out.windows.length, 2)
  assert.equal(out.windows[0].kind, 'session')
  assert.equal(out.windows[0].used_percent, 42)
  assert.equal(out.windows[1].kind, 'weekly')
})

check('claude legacy shape still works', () => {
  const out = normaliseUsagePayload('claude', {
    five_hour: { utilization: 30, resets_at: '2026-08-24T05:00:00Z' },
    seven_day: { utilization: 12 },
  })
  assert.equal(out.windows.length, 2)
  assert.equal(out.windows[0].used_percent, 30)
})

check('codex rate-limit windows are read', () => {
  const out = normaliseUsagePayload('codex', {
    rate_limit: {
      primary_window: { used_percent: 55, resets_in_seconds: 3600 },
      secondary_window: { used_percent: 9 },
    },
  })
  assert.equal(out.supported, true)
  assert.equal(out.windows[0].kind, 'session')
  assert.equal(out.windows[0].used_percent, 55)
  assert.equal(out.windows[1].kind, 'weekly')
})

check('grok reports a billing period percentage', () => {
  // The live payload carries config.creditUsagePercent over a weekly period,
  // not a credits balance.
  const out = normaliseUsagePayload('grok', {
    config: {
      creditUsagePercent: 1,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-08-27T18:37:19Z' },
    },
  })
  assert.equal(out.supported, true)
  assert.equal(out.windows[0].kind, 'weekly')
  assert.equal(out.windows[0].used_percent, 1)
  assert.match(out.windows[0].resets_at, /2026-08-27/)
})

check('grok credits balance also works', () => {
  const out = normaliseUsagePayload('grok', { credits: { remaining: 250, total: 1000 } })
  assert.equal(out.windows[0].used_percent, 75)
})

check('claude does not report the same window twice', () => {
  // The modern list and the legacy fields describe the same limits; emitting
  // both showed each window twice in the console.
  const out = normaliseUsagePayload('claude', {
    limits: [{ kind: 'session', percent: 15 }, { kind: 'weekly_all', percent: 98 }],
    five_hour: { utilization: 15 },
    seven_day: { utilization: 98 },
  })
  assert.equal(out.windows.length, 2, JSON.stringify(out.windows))
})

check('an unknown payload is unsupported, not a crash', () => {
  const out = normaliseUsagePayload('claude', { something: 'else' })
  assert.equal(out.supported, false)
  assert.deepEqual(out.windows, [])
})

check('a percentage is clamped to a sane range', () => {
  const out = normaliseUsagePayload('codex', { rate_limit: { primary_window: { used_percent: 140 } } })
  assert.equal(out.windows[0].used_percent, 100)
})

await acheck('an expired token is reported, not thrown', async () => {
  const res = await fetchProviderUsage('claude', { accessToken: 'x' }, async () => ({
    ok: false, status: 401, text: async () => 'expired',
  }))
  assert.equal(res.supported, false)
  assert.match(res.error, /401/)
})

await acheck('a network failure is reported, not thrown', async () => {
  const res = await fetchProviderUsage('grok', { accessToken: 'x' }, async () => {
    throw new Error('ECONNREFUSED')
  })
  assert.equal(res.supported, false)
  assert.match(res.error, /ECONNREFUSED/)
})

await acheck('a provider with no session is reported as not logged in', async () => {
  const res = await fetchProviderUsage('codex', undefined, async () => {
    throw new Error('should not be called')
  })
  assert.equal(res.supported, false)
  assert.match(res.error, /login/i)
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
