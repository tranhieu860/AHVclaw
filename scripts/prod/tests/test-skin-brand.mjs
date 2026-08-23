// The AHV brand must actually load, not merely be present on disk.
//
// The skin shipped a named `activate()` export for a long time while the
// skin-center contract requires a default-exported defineSkinHooks(); the
// runtime caught the import error, kept the static CSS and logged to the
// browser console, so on the server everything looked installed and the UI
// still read "DSH Local Build". These checks pin the two halves of the brand:
// the hooks contract, and the CSS fallback that has to agree with it when
// hooks do fail.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const assets = join(root, 'packages', 'bundle', 'ahv', 'skin-assets')

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (error) { console.log(`  FAIL  ${name}\n        ${error.message}`); failed++ }
}

const BRAND = 'AHV Harness'

await check('hooks.mjs default-exports the skin-center contract factory', async () => {
  const mod = await import(join(assets, 'hooks.mjs'))
  assert.equal(typeof mod.default, 'function', 'hooks.mjs must default-export defineSkinHooks()')
  const hooks = mod.default()
  assert.equal(typeof hooks.apply, 'function', 'the factory must return apply()')
})

await check('dispose is idempotent — a skin switch may call it 0, 1 or N times', async () => {
  const mod = await import(join(assets, 'hooks.mjs'))
  const hooks = mod.default()
  hooks.dispose()
  hooks.dispose()
})

await check('the CSS fallback name matches the hooks name', () => {
  const css = readFileSync(join(assets, 'patches.css'), 'utf8')
  assert.match(css, new RegExp(`content:\\s*"${BRAND}"`),
    `patches.css must fall back to "${BRAND}" when hooks fail`)
})

await check('hooks rebrand to the same name', () => {
  const src = readFileSync(join(assets, 'hooks.mjs'), 'utf8')
  assert.ok(src.includes(`'${BRAND}'`) || src.includes(`"${BRAND}"`), `hooks.mjs must use "${BRAND}"`)
  assert.ok(!/["']AHV CLI["']/.test(src), 'stale "AHV CLI" label left in hooks.mjs')
})

await check('the manifest points at the hooks entry', () => {
  const manifest = JSON.parse(readFileSync(join(assets, 'skin.json'), 'utf8'))
  assert.equal(manifest.id, 'ahv')
  assert.equal(manifest.facets?.client?.entry, 'hooks.mjs')
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
