#!/usr/bin/env node
// Each mutant must fail a behavioral assertion in a bounded isolated child suite.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
assert.ok(process.argv[2], 'usage: node test-auth-lock-recovery-mutations.mjs <patched-plugin-directory> [bot-file]')
const plugin = resolve(process.argv[2])
const bot = resolve(process.argv[3] ?? join(here, '../ahv-bot.mjs'))
const root = mkdtempSync(join(tmpdir(), 'auth-recovery-mutations-'))
const replace = (source, pattern, text) => {
  const matches = source.match(new RegExp(pattern.source, 'g')) ?? []
  assert.equal(matches.length, 1, `mutation anchor must occur once: ${pattern}`)
  return source.replace(pattern, text)
}
const mutations = [
  ['ignore-start', 'recover start', source => replace(source, /return typeof owner\.start === ["']string["'] && start !== null && owner\.start !== start/, 'return false')],
  ['ignore-boot', 'recover boot', source => replace(source, /if \(typeof owner\.boot === ["']string["'] && boot !== null && owner\.boot !== boot\) return true/, 'if (false) return true')],
  ['EPERM-is-dead', 'EPERM owner stays alive', source => replace(source, /return error\.code === ["']ESRCH["']/, 'return error.code === "ESRCH" || error.code === "EPERM"')],
  ['bypass-reclaim', 'rechecks changed owner under reclaim', source => replace(source, /await claimAuthLock\(reclaim, ownerText, owner, deadline\)/, 'void 0')],
  ['bypass-owner-reread', 'changed dead owner requires', source => replace(source, /if \(current\?\.text !== expected\) return/, 'void 0')],
  ['bypass-liveness-reread', 'rechecks owner liveness under reclaim', source => replace(source, /if \(ownerBoot !== undefined && !authLockOwnerDead\(current\.owner, ownerBoot\)\) return/, 'void 0')],
  ['short-wait-200ms', 'live owner waits 1300ms', source => replace(source, /const deadline = Date\.now\(\) \+ (?:30_000|3e4)/, 'const deadline = Date.now() + 200')],
  ['null-start-is-dead', 'no-proc-live owner stays alive', source => replace(source, /return typeof owner\.start === ["']string["'] && start !== null && owner\.start !== start/, 'return start === null || typeof owner.start === "string" && owner.start !== start')],
  ['parse-first-parenthesis', 'proc stat start survives', source => replace(source, /stat\.lastIndexOf\((["'])\)\1\)/, 'stat.indexOf(")")')],
]
const run = (pluginPath, botPath, filter) => spawnSync(process.execPath, [join(here, 'test-auth-lock-recovery.mjs'), pluginPath], {
  env: { PATH: process.env.PATH, HOME: root, AHV_BOT_UNDER_TEST: botPath, ...(filter ? { AUTH_LOCK_TEST_FILTER: filter } : {}) },
  encoding: 'utf8', timeout: filter ? 12000 : 70000,
})
let killed = 0, survived = 0
try {
  const baseline = run(plugin, bot)
  assert.equal(baseline.error, undefined, `baseline process error: ${baseline.error}`)
  assert.equal(baseline.status, 0, `baseline must pass: ${baseline.stdout}\n${baseline.stderr}`)
  console.log('BASELINE passed')
  for (const engine of ['bot', 'plugin']) {
    const sourcePath = engine === 'bot' ? bot : join(plugin, 'lib/index.js')
    const source = readFileSync(sourcePath, 'utf8')
    for (const [name, filter, mutate] of mutations) {
      const caseName = `${engine}-${name}`
      const candidate = join(root, caseName)
      let nextPlugin = plugin, nextBot = bot
      if (engine === 'bot') { nextBot = `${candidate}.mjs`; writeFileSync(nextBot, mutate(source)) }
      else { cpSync(plugin, candidate, { recursive: true }); nextPlugin = candidate; writeFileSync(join(candidate, 'lib/index.js'), mutate(source)) }
      const result = run(nextPlugin, nextBot, `${engine}: ${filter}`)
      assert.equal(result.error, undefined, `${caseName} outer timeout/process error is not a killed mutation: ${result.error}`)
      assert.equal(result.signal, null, `${caseName} signal termination is not a killed mutation`)
      if (result.status === 1 && /FAIL .*AssertionError \[ERR_ASSERTION\]/.test(result.stderr)) {
        console.log(`KILLED ${caseName}`)
        killed++
      } else if (result.status === 0) { console.log(`SURVIVED ${caseName}`); survived++ }
      else throw new Error(`${caseName} failed without a behavioral assertion: ${result.stdout}\n${result.stderr}`)
    }
  }
  console.log(`${killed} killed, ${survived} survived, ${mutations.length * 2} executed`)
  process.exitCode = survived ? 1 : 0
} finally { rmSync(root, { recursive: true, force: true }) }
