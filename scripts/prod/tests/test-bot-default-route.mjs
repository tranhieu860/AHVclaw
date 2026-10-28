// The bot adapter reports the route a run really takes (#976).
//
// `ahv auth status` and `ahv doctor` print the default model and base URL, and
// doctor probes that URL. Left pointing at the router on #1 after the patch
// moved to AHV AI, they would report a route no run uses; a bot still exporting
// AHV_MODEL=ahv-qwen38 must see AHV-Holding, which is what its turns run on.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BOT = fileURLToPath(new URL('../ahv-bot.mjs', import.meta.url))
const PATCH = readFileSync(fileURLToPath(new URL('../../../packages/bundle/ahv/cordis.patch.yml', import.meta.url)), 'utf8')
const PATCH_URL = /^\s+baseURL:\s*(\S+)\s*$/m.exec(PATCH)?.[1]

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++ }
}

/** `ahv auth status --json` in an empty home (no ~/.ahv/env), with the given environment. */
function authStatus(env) {
  const home = mkdtempSync(join(tmpdir(), 'botroute-'))
  const base = { PATH: process.env.PATH, HOME: home, DSH_HOME: join(home, '.dsh') }
  return JSON.parse(execFileSync(process.execPath, [BOT, 'auth', 'status', '--json'], { env: { ...base, ...env }, encoding: 'utf8' }))
}

check('reports the base URL the bundle patch routes to', () => {
  assert.equal(PATCH_URL, 'https://auto.ahvchat.com/v1')
  assert.equal(authStatus({}).base_url, PATCH_URL)
})
check('defaults to AHV-Holding', () => {
  assert.equal(authStatus({}).model, 'AHV-Holding')
})
check('a bot still exporting AHV_MODEL=ahv-qwen38 sees AHV-Holding', () => {
  assert.equal(authStatus({ AHV_MODEL: 'ahv-qwen38', AHV_API_KEY: 'k' }).model, 'AHV-Holding')
})
check('any other AHV_MODEL is reported as set', () => {
  assert.equal(authStatus({ AHV_MODEL: 'AHV-Holding-TroLy' }).model, 'AHV-Holding-TroLy')
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
