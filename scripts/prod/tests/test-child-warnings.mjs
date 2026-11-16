// filterChildWarnings: what of a successful dsh child's stderr may reach the caller's JSON.
import assert from 'node:assert/strict'

const { filterChildWarnings } = await import(new URL('../ahv-bot.mjs', import.meta.url).href)

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++ }
}

check('keeps a plain notice', () => {
  assert.deepEqual(filterChildWarnings('subscriptions: claude: token bị từ chối\n'), ['subscriptions: claude: token bị từ chối'])
})
check('drops stack frames and absolute paths', () => {
  const text = ['Error: boom', '    at run (/home/u/x.js:1:2)', 'loading /home/u/.dsh/plugins/x failed', 'C:\\Users\\u\\x failed', 'file:///x/y'].join('\n')
  assert.deepEqual(filterChildWarnings(text), ['Error: boom'])
})
check('masks bearer and long opaque strings', () => {
  const out = filterChildWarnings('Bearer abc.def and sk-abcdefgh12345 and ' + 'a'.repeat(40))
  assert.equal(out.length, 1)
  assert.ok(!/abc\.def|abcdefgh12345|aaaaaaaa/.test(out[0]), out[0])
})
check('caps count and length, ignores empty and ANSI', () => {
  const out = filterChildWarnings(Array.from({ length: 9 }, (_, i) => `\x1b[31m${i} ${'ww '.repeat(100)}\x1b[0m`).join('\n\n'))
  assert.equal(out.length, 5)
  assert.ok(out.every(l => l.length === 200 && !l.includes('\x1b')))
  assert.deepEqual(filterChildWarnings(''), [])
})
check('quotes and backslashes become apostrophes', () => {
  assert.deepEqual(filterChildWarnings('Unknown config key: "foo" \\n'), ["Unknown config key: 'foo' 'n"])
})
check('identical lines are reported once, in order', () => {
  assert.deepEqual(filterChildWarnings('b\na\nb\na\nc'), ['b', 'a', 'c'])
})
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
