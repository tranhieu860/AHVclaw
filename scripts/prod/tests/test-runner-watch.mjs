// A bot runner that fails to mount must end the run, not hang it.
//
// dsh 0.2 only warns when plugin rows do not activate and keeps the process
// alive; with no runner nothing ever exits, so the Telegram bot waited out its
// whole timeout. Other plugins failing (market, browser) must not end the run.
import assert from 'node:assert/strict'

const { runnerLoadWatcher } = await import(new URL('../ahv-bot.mjs', import.meta.url).href)

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++ }
}
const BLOCK = [
  'dsh: warning: 7 entries did not activate',
  'dsh-market (dshmarket): failed to import',
  'browser (@anweat/dsh-browser): failed to import',
  'bot-startup (@ahvclaw/dsh-bundle-ahv/bot-startup): failed to import',
  'bot-runner (@ahvclaw/dsh-bundle-ahv/bot-runner): failed to import',
  '',
].join('\n')

check('fires on the runner rows of the warning block, once', () => {
  const hits = []
  const watch = runnerLoadWatcher(line => hits.push(line))
  watch(Buffer.from(BLOCK))
  assert.deepEqual(hits, ['bot-startup (@ahvclaw/dsh-bundle-ahv/bot-startup): failed to import'])
})
check('a line split across chunks is still seen', () => {
  const hits = []
  const watch = runnerLoadWatcher(line => hits.push(line))
  watch(Buffer.from('dsh: warning: 1 entries did not activate\nbot-run'))
  assert.equal(hits.length, 0)
  watch(Buffer.from('ner (@ahvclaw/dsh-bundle-ahv/bot-runner): failed to import\n'))
  assert.equal(hits.length, 1)
})
check('other plugins failing do not end the run', () => {
  const hits = []
  const watch = runnerLoadWatcher(line => hits.push(line))
  watch(Buffer.from('dsh: warning: 2 entries did not activate\ndsh-market (dshmarket): failed to import\nbrowser (@anweat/dsh-browser): failed to import\n'))
  assert.equal(hits.length, 0)
})
check('model text mentioning bot-runner mid-line does not fire', () => {
  const hits = []
  const watch = runnerLoadWatcher(line => hits.push(line))
  watch(Buffer.from('dsh: reasoning: the bot-runner (x): is fine\n'))
  assert.equal(hits.length, 0)
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
