#!/usr/bin/env node
// Run selected auth-store faults against copies; fake credentials and network only.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = new URL('../ahv-bot.mjs', import.meta.url)
const suite = new URL('./test-bot-auth-store.mjs', import.meta.url).pathname
const original = readFileSync(source, 'utf8')
const mutations = [
  ['ignore shared mutex', 'logout waits', 'async function withAuthLock(path, callback) {', 'async function withAuthLock(path, callback) {\n  return callback()'],
  ['unstable provider mutex', 'concurrent refreshes', '`${authPath}.refresh-${kind}.lock`', '`${authPath}.refresh-${kind}-${Math.random()}.lock`'],
  ['reuse snapshot after waiting', 'refresh rereads the token', 'const current = storedAccount(readSubscriptionsAuthForWrite(authPath)[kind], key)', 'const current = { key, session }'],
  ['ignore refresh CAS', 'cannot resurrect', 'if (!existing.session || !sameAuthTokens(existing.session, current.session))', 'if (false)'],
  ['ignore access-token CAS', 'refresh CAS preserves', 'return left?.accessToken === right?.accessToken && left?.refreshToken === right?.refreshToken', 'return left?.refreshToken === right?.refreshToken'],
  ['ignore refresh-token CAS', 'refresh CAS preserves', 'return left?.accessToken === right?.accessToken && left?.refreshToken === right?.refreshToken', 'return left?.accessToken === right?.accessToken'],
  ['return stale failed refresh', 'does not fall back', 'const fresh = await refreshWithBook(kind, current.key, current.session, book, fetchFn, now)', 'const fresh = await refreshWithBook(kind, current.key, current.session, book, fetchFn, now)\n      if (!fresh.refreshed) return fresh'],
  ['exit with owned work pending', 'drains other', 'async function completeAuthWork(tasks) {', 'async function completeAuthWork(tasks) {\n  return Promise.all(tasks)'],
  ['alias shadows actual account', 'historical alias', '!Object.hasOwn(accounts, key) && typeof entry?.aliases?.[key]', 'typeof entry?.aliases?.[key]'],
  ['import writes stale store', 'import rereads the store', 'store = readSubscriptionsAuthForWrite(storePath)', 'store = structuredClone(before)'],
  ['import ignores changed login', 'import rereads the store', 'if (!sameAuthTokens(current, initialSession))', 'if (false)'],
  ['import revives logged-out provider', 'provider logout cancels', 'if (Object.hasOwn(before, provider) && !Object.hasOwn(store, provider))', 'if (false)'],
  ['drop issuer refresh deadline', 'refresh lifetime changes', '? { refreshTokenExpiresAt: refreshDeadline } : {}', '? {} : {}'],
  ['accept overflowing deadline', 'refresh lifetime changes', ' && Number.isFinite(refreshDeadline)', ''],
  ['drop CLI refresh deadline', 'CLI import copies', '? { refreshTokenExpiresAt: raw.refreshTokenExpiresAt } : {}', '? {} : {}'],
]
const root = mkdtempSync(join(tmpdir(), 'ahv-bot-auth-mutants-'))
let killed = 0
try {
  const baseline = spawnSync(process.execPath, [suite], {
    env: { PATH: process.env.PATH, HOME: root, DSH_HOME: join(root, '.dsh') }, encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(baseline.error, undefined, baseline.error?.message)
  assert.equal(baseline.status, 0, `unmutated suite failed:\n${baseline.stdout}\n${baseline.stderr}`)
  console.log(`BASELINE ${baseline.stdout.trim().split('\n').at(-1)}`)
  for (const [name, filter, before, after] of mutations) {
    assert.equal(original.split(before).length, 2, `mutation anchor must be unique: ${name}`)
    const mutant = join(root, 'ahv-bot.mjs')
    writeFileSync(mutant, original.replace(before, after))
    const result = spawnSync(process.execPath, [suite], {
      env: { PATH: process.env.PATH, HOME: root, DSH_HOME: join(root, '.dsh'), AHV_BOT_UNDER_TEST: mutant, BOT_AUTH_TEST_FILTER: filter },
      encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(result.error, undefined, `${name}: ${result.error?.message}`)
    assert.notEqual(result.status, 0, `survived: ${name}\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /FAIL /, `mutation must fail a behavior assertion: ${name}\n${result.stderr}`)
    console.log(`KILLED ${name}`)
    killed++
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(`${killed}/${mutations.length} selected mutations killed`)
