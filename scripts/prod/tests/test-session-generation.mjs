// `ahv sessions` must read the newest session log generation.
//
// dsh 0.2 migrates a version-0 `session.jsonl.zstd` into `session.v4.jsonl.zstd`
// on first open and keeps the source for rollback. The bot sizes the context of
// a conversation from the path this returns, so reading the frozen v0 file after
// an upgrade would report the conversation as it was on upgrade day.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const { currentSessionLog } = await import(new URL('../ahv-bot.mjs', import.meta.url).href)

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++ }
}
function dir(...files) {
  const d = mkdtempSync(join(tmpdir(), 'sessgen-'))
  for (const f of files) writeFileSync(join(d, f), '')
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
check('a directory with no log yields null', () => {
  assert.equal(currentSessionLog(dir('session.lock', 'notes.txt')), null)
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
