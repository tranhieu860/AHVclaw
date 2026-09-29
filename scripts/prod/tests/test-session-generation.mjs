// `ahv sessions` must read the newest session log generation.
//
// dsh 0.2 migrates a version-0 `session.jsonl.zstd` into `session.v4.jsonl.zstd`
// on first open and keeps the source for rollback. The bot sizes the context of
// a conversation from the path this returns, so reading the frozen v0 file after
// an upgrade would report the conversation as it was on upgrade day.
import { mkdtempSync, writeFileSync, utimesSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const { currentSessionLog, supersedeStaleGenerations } = await import(new URL('../ahv-bot.mjs', import.meta.url).href)

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++ }
}
// Files get increasing mtimes in argument order, like a real history.
function dir(...files) {
  const d = mkdtempSync(join(tmpdir(), 'sessgen-'))
  files.forEach((f, i) => { writeFileSync(join(d, f), ''); utimesSync(join(d, f), 1000 + i, 1000 + i) })
  return d
}

check('a legacy-only session reads session.jsonl.zstd', () => {
  const d = dir('session.jsonl.zstd', 'session.lock')
  assert.equal(currentSessionLog(d), join(d, 'session.jsonl.zstd'))
})
check('a migrated session reads the v4 generation, not the kept v0 source', () => {
  const d = dir('session.jsonl.zstd', 'session.v4.jsonl.zstd', 'session.turn.lock')
  assert.equal(currentSessionLog(d), join(d, 'session.v4.jsonl.zstd'))
})
check('generations compare numerically (v10 beats v4)', () => {
  const d = dir('session.v4.jsonl.zstd', 'session.v10.jsonl.zstd')
  assert.equal(currentSessionLog(d), join(d, 'session.v10.jsonl.zstd'))
})
check('the compressed file wins within one generation', () => {
  const d = dir('session.v4.jsonl', 'session.v4.jsonl.zstd')
  assert.equal(currentSessionLog(d), join(d, 'session.v4.jsonl.zstd'))
})
check('an uncompressed legacy log is still found', () => {
  const d = dir('session.jsonl')
  assert.equal(currentSessionLog(d), join(d, 'session.jsonl'))
})
check('after a rollback wrote the v0 log again, that log is the live one', () => {
  const d = dir('session.v4.jsonl.zstd', 'session.jsonl.zstd')
  assert.equal(currentSessionLog(d), join(d, 'session.jsonl.zstd'))
})
check('resume after a rollback moves the stale generation aside (never deletes)', () => {
  const d = dir('session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.lock')
  const moved = supersedeStaleGenerations(d, 42)
  assert.deepEqual(moved, [join(d, 'session.v4.jsonl.zstd.superseded-42')])
  assert.ok(existsSync(moved[0]))
  assert.ok(!existsSync(join(d, 'session.v4.jsonl.zstd')))
  assert.ok(existsSync(join(d, 'session.jsonl.zstd')))
})
check('a normally migrated session is left alone', () => {
  const d = dir('session.jsonl.zstd', 'session.v4.jsonl.zstd')
  assert.deepEqual(supersedeStaleGenerations(d), [])
  assert.deepEqual(readdirSync(d).sort(), ['session.jsonl.zstd', 'session.v4.jsonl.zstd'])
})
check('legacy-only and migrated-only sessions are left alone', () => {
  assert.deepEqual(supersedeStaleGenerations(dir('session.jsonl.zstd')), [])
  assert.deepEqual(supersedeStaleGenerations(dir('session.v4.jsonl.zstd')), [])
})
check('a directory with no log yields null', () => {
  assert.equal(currentSessionLog(dir('session.lock', 'notes.txt')), null)
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
