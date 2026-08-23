// A provider that answered a moment ago must not vanish from the catalog.
//
// The harness lists each provider separately and drops any that fails to answer
// in time, so the same command returned 32 models, then 22, then 29 — the model
// the operator had chosen could simply not be there. Topping up from the cache
// fixes that, but the cache is also how Claude once appeared for a user who had
// never logged in, so only providers with a live session may be restored.
import assert from 'node:assert/strict'

const mod = await import('/home/claudeproxy/Claude/AHVclaw-fork/scripts/prod/ahv-bot.mjs')
const { topUpMissingProviders } = mod

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (error) { console.log(`  FAIL  ${name}\n        ${error.message}`); failed++ }
}

const live = [
  { id: 'grok-4.6', provider: 'grok', provider_name: 'Grok (Subscription)' },
  { id: 'ahv-qwen38', provider: 'ahv-router', provider_name: 'AHV Router' },
]
const cache = {
  models: [
    { model_id: 'claude-sonnet-4-5', model_name: 'Sonnet', provider: 'claude', provider_name: 'Claude (Subscription)' },
    { model_id: 'grok-4.6', model_name: 'Grok', provider: 'grok', provider_name: 'Grok (Subscription)' },
  ],
  providers: [{ id: 'claude', name: 'Claude (Subscription)' }, { id: 'grok', name: 'Grok (Subscription)' }],
}

check('a logged-in provider missing from this listing is restored', () => {
  const { models, restored } = topUpMissingProviders(live, cache, ['claude', 'grok'])
  assert.deepEqual(restored, ['claude'])
  assert.ok(models.some(m => m.id === 'claude-sonnet-4-5'))
})

check('a provider that is not logged in is never invented', () => {
  // This is exactly how Claude once appeared for a user with no credentials.
  const { models, restored } = topUpMissingProviders(live, cache, ['grok'])
  assert.deepEqual(restored, [])
  assert.ok(!models.some(m => m.id === 'claude-sonnet-4-5'))
})

check('a provider already in the listing is left untouched', () => {
  const { models } = topUpMissingProviders(live, cache, ['grok'])
  assert.equal(models.filter(m => m.id === 'grok-4.6').length, 1)
})

check('restored models are marked so the caller knows they are cached', () => {
  const { models } = topUpMissingProviders(live, cache, ['claude'])
  const restored = models.find(m => m.id === 'claude-sonnet-4-5')
  assert.equal(restored.stale, true)
  assert.equal(models.find(m => m.id === 'grok-4.6').stale, undefined)
})

check('the live listing is returned unchanged when nothing is missing', () => {
  const { models, restored } = topUpMissingProviders(live, { models: [], providers: [] }, ['grok'])
  assert.deepEqual(restored, [])
  assert.equal(models.length, live.length)
})

check('an empty cache cannot break the listing', () => {
  const { models } = topUpMissingProviders(live, null, ['claude'])
  assert.equal(models.length, live.length)
})

check('the original list is not mutated', () => {
  const before = live.length
  topUpMissingProviders(live, cache, ['claude'])
  assert.equal(live.length, before)
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
