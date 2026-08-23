// Doctor must notice when the running plugin code is not the installed code.
//
// The profile's module farm resolves `@ahvclaw/dsh-bundle-ahv` for every run.
// When that link pointed into another user's home, an installed upgrade had no
// effect and the only symptom was that a fix "did not work" — hours to find by
// hand, five seconds to see if something checks it.
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const { checkProfileBundleLink } = await import('/home/claudeproxy/Claude/AHVclaw-fork/scripts/prod/ahv-bot.mjs')

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++ }
}

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'profchk-'))
  const fork = join(root, 'src')
  mkdirSync(join(fork, 'packages/bundle/ahv'), { recursive: true })
  mkdirSync(join(root, 'dsh/profiles/node_modules/@ahvclaw'), { recursive: true })
  return { root, fork, farm: join(root, 'dsh/profiles/node_modules') }
}

check('a farm linked to this install passes', () => {
  const { root, fork, farm } = scaffold()
  symlinkSync(join(fork, 'packages/bundle/ahv'), join(farm, '@ahvclaw/dsh-bundle-ahv'))
  const result = checkProfileBundleLink(fork, join(root, 'dsh'))
  assert.equal(result.severity, 'ok', JSON.stringify(result))
})

check('a farm pointing at a different tree is an error', () => {
  const { root, fork, farm } = scaffold()
  const other = mkdtempSync(join(tmpdir(), 'other-'))
  mkdirSync(join(other, 'packages/bundle/ahv'), { recursive: true })
  symlinkSync(join(other, 'packages/bundle/ahv'), join(farm, '@ahvclaw/dsh-bundle-ahv'))
  const result = checkProfileBundleLink(fork, join(root, 'dsh'))
  assert.equal(result.severity, 'error', JSON.stringify(result))
  assert.match(String(result.note ?? result.error ?? ''), /install/i)
})

check('a farm that does not exist yet is not an error', () => {
  // dsh scaffolds it on first run; a fresh install has none.
  const { root, fork } = scaffold()
  const result = checkProfileBundleLink(fork, join(root, 'nowhere'))
  assert.notEqual(result.severity, 'error', JSON.stringify(result))
})

check('a farm without the bundle linked is only a warning', () => {
  const { root, fork } = scaffold()
  const result = checkProfileBundleLink(fork, join(root, 'dsh'))
  assert.equal(result.severity, 'warn', JSON.stringify(result))
})

check('the check reports where the link actually goes', () => {
  const { root, fork, farm } = scaffold()
  const other = mkdtempSync(join(tmpdir(), 'other2-'))
  mkdirSync(join(other, 'packages/bundle/ahv'), { recursive: true })
  symlinkSync(join(other, 'packages/bundle/ahv'), join(farm, '@ahvclaw/dsh-bundle-ahv'))
  const result = checkProfileBundleLink(fork, join(root, 'dsh'))
  assert.ok(String(result.value).includes(other), JSON.stringify(result))
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
