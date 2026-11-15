#!/usr/bin/env node
// Shared auth-store races, using fake credentials and temporary HOME before import.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'

const home = mkdtempSync(join(tmpdir(), 'ahv-bot-auth-'))
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
process.env.HOME = home
process.env.DSH_HOME = join(home, '.dsh')
process.env.AHV_FORK = new URL('../../..', import.meta.url).pathname
delete process.env.CLAUDE_CONFIG_DIR
globalThis.fetch = async () => { throw new Error('real network forbidden') }
const bot = resolve(process.env.AHV_BOT_UNDER_TEST ?? new URL('../ahv-bot.mjs', import.meta.url).pathname)
const { loginRefreshReport, loginUsageReport, importCliCredentials, withAccountSession, REFRESH_ENDPOINTS } = await import(pathToFileURL(bot).href)
const store = join(process.env.DSH_HOME, 'plugins/subscriptions/auth.json')
mkdirSync(dirname(store), { recursive: true })
const now = 1_800_000_000_000
const old = { accessToken: 'fake-old', refreshToken: 'fake-refresh', expiresAt: now - 1, emailAddress: 'old@example.test', refreshTokenExpiresAt: now + 50_000_000 }
const entry = session => ({ default: 'old@example.test', accounts: { 'old@example.test': session } })
const read = () => JSON.parse(readFileSync(store, 'utf8'))
const write = auth => writeFileSync(store, JSON.stringify(auth), { mode: 0o600 })
const ok = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body })
const tokens = () => ok({ access_token: 'fake-refreshed', refresh_token: 'fake-rotated', expires_in: 3600 })
let passed = 0
let failed = 0
async function check(name, callback) {
  if (process.env.BOT_AUTH_TEST_FILTER && !name.includes(process.env.BOT_AUTH_TEST_FILTER)) return
  rmSync(dirname(store), { recursive: true, force: true })
  mkdirSync(dirname(store), { recursive: true })
  for (const dir of ['.claude', '.grok', '.codex']) rmSync(join(home, dir), { recursive: true, force: true })
  try { await callback(); console.log(`PASS ${name}`); passed++ }
  catch (error) { console.error(`FAIL ${name}: ${error.stack}`); failed++ }
}

function cli(args, traceLock) {
  const preload = join(home, 'observe-lock.mjs')
  if (traceLock) writeFileSync(preload, `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.renameSync; let sent = false;
    fs.renameSync = function(from, to, ...args) {
      if (to === ${JSON.stringify(traceLock)} && !sent) { sent = true; process.send('lock-attempt') }
      return rename.call(this, from, to, ...args);
    };
    syncBuiltinESMExports();
    globalThis.fetch = async () => { throw new Error('real network forbidden') };
  `)
  const child = spawn(process.execPath, [...(traceLock ? ['--import', preload] : []), bot, 'login', ...args, '--json'], {
    env: { ...process.env, HOME: home, DSH_HOME: process.env.DSH_HOME }, stdio: ['ignore', 'pipe', 'pipe', ...(traceLock ? ['ipc'] : [])],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const done = once(child, 'close').then(([code]) => ({ code, stdout, stderr }))
  return { child, done }
}

async function holdLock(path) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
    const path = ${JSON.stringify(path)};
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(path + '/owner.json', JSON.stringify({pid:process.pid}), {mode:0o600});
    process.stdout.write('locked\\n');
    process.stdin.once('data', () => { const retired = path + '.released-' + process.pid; renameSync(path, retired); rmSync(retired, {recursive:true,force:true}); process.exit(0) });
  `], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const done = once(child, 'exit')
  await once(child.stdout, 'data')
  assert.equal(statSync(path).mode & 0o777, 0o700)
  assert.equal(statSync(join(path, 'owner.json')).mode & 0o777, 0o600)
  let released = false
  return async () => {
    if (released) return
    released = true
    child.stdin.end('release')
    await done
  }
}

for (const action of ['logout', 'forget', 'use', 'import']) {
  await check(`${action} waits for shared write lock and preserves concurrent providers`, async () => {
    write({ claude: entry(old) })
    const unlock = await holdLock(`${store}.lock`)
    if (action === 'import') {
      mkdirSync(join(home, '.grok'), { recursive: true })
      writeFileSync(join(home, '.grok/auth.json'), JSON.stringify({ access_token: 'fake-grok', refresh_token: 'fake-grok-r', expires_at: now + 500_000 }))
    }
    const args = action === 'forget' || action === 'use' ? [action, 'claude', 'old@example.test'] : action === 'logout' ? [action, 'claude'] : [action]
    const process = cli(args, `${store}.lock`)
    try {
      const attemptedLock = await Promise.race([
        once(process.child, 'message').then(() => true),
        process.done.then(() => false),
      ])
      const current = read()
      const before = JSON.stringify(current)
      current.codex = { accessToken: 'fake-concurrent', refreshToken: 'fake-concurrent-r', expiresAt: now + 900_000, accountId: 'concurrent' }
      write(current)
      await unlock()
      const result = await process.done
      assert.equal(attemptedLock, true, 'mutation must attempt the plugin write lock before completing')
      assert.ok(before.includes('fake-old'), 'store was not changed before acquiring lock')
      assert.equal(result.code, 0, result.stderr + result.stdout)
      assert.equal(read().codex?.accessToken, 'fake-concurrent')
      assert.equal(existsSync(`${store}.lock`), false)
    } finally {
      await unlock()
      if (process.child.exitCode === null) process.child.kill()
      await process.done
    }
  })
}

await check('refresh cannot resurrect an account logged out during its endpoint request', async () => {
  write({ claude: entry(old) })
  const result = await loginRefreshReport({ now, fetchFn: async () => {
    const result = await cli(['logout', 'claude']).done
    assert.equal(result.code, 0, result.stderr)
    return tokens()
  } })
  assert.equal(read().claude, undefined)
  assert.equal(result.providers.claude.accounts[0].refreshed, false)
  assert.equal(existsSync(`${store}.refresh-claude.lock`), false)
})

await check('refresh CAS preserves a replacement login even when its expiry is shorter', async () => {
  for (const changes of [{ accessToken: 'fake-relogin' }, { refreshToken: 'fake-relogin-r' }, { accessToken: 'fake-relogin', refreshToken: 'fake-relogin-r' }]) {
    write({ claude: entry(old) })
    const replacement = { ...old, ...changes, expiresAt: now + 300_000 }
    const result = await loginUsageReport({ now, fetchFn: async url => {
      if (url === REFRESH_ENDPOINTS.claude.url) { write({ claude: entry(replacement) }); return tokens() }
      return ok({ limits: [] })
    } })
    assert.deepEqual(read().claude.accounts['old@example.test'], replacement)
    assert.equal(result.providers.claude.accounts[0].refreshed, undefined)
  }
})

await check('usage does not reuse a refreshed token after logout wins the CAS', async () => {
  write({ claude: entry(old) })
  let usageCalls = 0
  const result = await loginUsageReport({ now, fetchFn: async url => {
    if (url === REFRESH_ENDPOINTS.claude.url) {
      assert.equal((await cli(['logout', 'claude']).done).code, 0)
      return tokens()
    }
    usageCalls++
    return ok({ limits: [] })
  } })
  assert.equal(usageCalls, 0)
  assert.equal(result.providers.claude.logged_in, false)
  assert.equal(read().claude, undefined)
})

await check('usage does not fall back to a logged-out token when refresh fails', async () => {
  write({ claude: entry(old) })
  let usageCalls = 0
  const result = await loginUsageReport({ now, fetchFn: async url => {
    if (url === REFRESH_ENDPOINTS.claude.url) {
      assert.equal((await cli(['logout', 'claude']).done).code, 0)
      return { ok: false, status: 503, text: async () => 'fake unavailable' }
    }
    usageCalls++
    return ok({ limits: [] })
  } })
  assert.equal(usageCalls, 0)
  assert.equal(result.providers.claude.logged_in, false)
  assert.equal(read().claude, undefined)
})

await check('concurrent refreshes send the one-use token to the endpoint once', async () => {
  write({ claude: entry(old) })
  let calls = 0
  let finish
  const endpoint = new Promise(resolve => { finish = resolve })
  const fetchFn = async () => { calls++; await endpoint; return tokens() }
  const first = loginRefreshReport({ now, fetchFn })
  const second = loginRefreshReport({ now, fetchFn })
  finish()
  await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(read().claude.accounts['old@example.test'].accessToken, 'fake-refreshed')
  assert.equal(read().claude.accounts['old@example.test'].refreshTokenExpiresAt, old.refreshTokenExpiresAt)
})

await check('refresh rereads the token after waiting for the plugin provider lock', async () => {
  write({ claude: entry(old) })
  const unlock = await holdLock(`${store}.refresh-claude.lock`)
  let calls = 0
  const pending = loginRefreshReport({ now, fetchFn: async () => { calls++; return tokens() } })
  try {
    const callsWhileLocked = calls
    write({ claude: { default: 'canonical', accounts: { canonical: { ...old, accessToken: 'fake-plugin-new', refreshToken: 'fake-plugin-new-r', expiresAt: now + 3_600_000 } }, aliases: { 'old@example.test': 'canonical' } } })
    await unlock()
    await pending
    assert.equal(callsWhileLocked, 0)
    assert.equal(calls, 0, 'fresh token from plugin means no second endpoint call')
    assert.equal(read().claude.accounts.canonical.accessToken, 'fake-plugin-new')
  } finally {
    await unlock()
    await pending
  }
})

await check('an existing account takes precedence over a historical alias', async () => {
  write({ codex: { default: 'legacy', accounts: { legacy: { ...old, accessToken: 'fake-A' }, canonical: { ...old, accessToken: 'fake-B' } }, aliases: { legacy: 'canonical' } } })
  const used = []
  await loginUsageReport({ now, fetchFn: async (_url, init) => { used.push(init.headers.authorization); return ok({}) } })
  assert.deepEqual(used.sort(), ['Bearer fake-A', 'Bearer fake-B'])
})

await check('import rereads the store after profile lookup and preserves a concurrent login', async () => {
  write({ claude: entry(old) })
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-import', refreshToken: 'fake-import-r', expiresAt: now + 9_000_000 } }))
  const result = await importCliCredentials({ home, fetchFn: async () => {
    write({ claude: entry({ ...old, accessToken: 'fake-relogin', refreshToken: 'fake-relogin-r', expiresAt: now + 300_000 }), codex: { accessToken: 'fake-concurrent', expiresAt: now } })
    return ok({ account: { email: 'old@example.test' } })
  } })
  assert.equal(read().codex?.accessToken, 'fake-concurrent')
  assert.equal(read().claude.accounts['old@example.test'].accessToken, 'fake-relogin')
  assert.equal(result.claude.imported, false)
})

await check('provider logout cancels an earlier import whose profile identifies a new account', async () => {
  write({ claude: entry(old) })
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-import', refreshToken: 'fake-import-r', expiresAt: now + 9_000_000 } }))
  const result = await importCliCredentials({ home, fetchFn: async () => {
    assert.equal((await cli(['logout', 'claude']).done).code, 0)
    return ok({ account: { email: 'new@example.test' } })
  } })
  assert.equal(read().claude, undefined)
  assert.equal(result.claude.imported, false)
})

await check('refresh lifetime changes only when the issuer supplies usable metadata', async () => {
  for (const seconds of [120, undefined, -1, '120', Number.MAX_VALUE]) {
    write({ claude: entry(old) })
    await loginRefreshReport({ now, fetchFn: async () => ok({ access_token: 'fake-renewed', expires_in: 3600, refresh_token_expires_in: seconds }) })
    assert.equal(read().claude.accounts['old@example.test'].refreshTokenExpiresAt, seconds === 120 ? now + 120_000 : old.refreshTokenExpiresAt)
  }
  const { refreshTokenExpiresAt: ignored, ...unknown } = old
  write({ claude: entry(unknown) })
  await loginRefreshReport({ now, fetchFn: async () => tokens() })
  assert.equal(Object.hasOwn(read().claude.accounts['old@example.test'], 'refreshTokenExpiresAt'), false)
})

await check('CLI import copies an optional refresh deadline without inventing one', async () => {
  for (const deadline of [now + 800_000, undefined]) {
    write({})
    mkdirSync(join(home, '.grok'), { recursive: true })
    writeFileSync(join(home, '.grok/auth.json'), JSON.stringify({ access_token: 'fake-grok', refresh_token: 'fake-grok-r', expires_at: now + 500_000, refreshTokenExpiresAt: deadline }))
    await importCliCredentials({ home })
    const grok = Object.values(read().grok.accounts)[0]
    assert.equal(grok.refreshTokenExpiresAt, deadline)
    assert.equal(Object.hasOwn(grok, 'refreshTokenExpiresAt'), deadline !== undefined)
  }
})

for (const action of ['refresh', 'usage']) {
  await check(`${action} drains other refresh work before exiting after a store error`, async () => {
    const expired = { ...old, expiresAt: Date.now() - 1 }
    write({ claude: entry(expired), antigravity: { default: 'google', accounts: { google: { ...expired, account: 'google' } } } })
    const preload = join(home, 'fake-endpoints.mjs')
    writeFileSync(preload, `
      import { writeFileSync } from 'node:fs';
      let release; const otherEntered = new Promise(resolve => { release = resolve });
      const ok = () => ({ok:true,status:200,headers:{get:()=>null},json:async()=>({access_token:'fake-next',refresh_token:'fake-next-r',expires_in:3600})});
      globalThis.fetch = async url => {
        if (String(url).includes('claude.ai')) { await otherEntered; writeFileSync(${JSON.stringify(store)}, '{'); return ok() }
        if (String(url).includes('oauth2.googleapis.com')) { release(); await new Promise(resolve => setTimeout(resolve, 150)); return ok() }
        throw new Error('unexpected endpoint; real network forbidden');
      };
    `)
    const result = spawnSync(process.execPath, ['--import', preload, bot, 'login', action, '--json'], {
      env: { ...process.env, ANTIGRAVITY_CLIENT_ID: 'fake-client', ANTIGRAVITY_CLIENT_SECRET: 'fake-secret' }, encoding: 'utf8', timeout: 5000,
    })
    assert.equal(result.status, 1, result.stderr)
    assert.deepEqual(readdirSync(dirname(store)).filter(name => name.endsWith('.lock')), [], 'a peer refresh lock was abandoned on process exit')
  })
}

await check('write failures keep permission errors structured and release the store lock', async () => {
  const preload = join(home, 'deny-auth-rename.mjs')
  writeFileSync(preload, `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const rename = fs.renameSync;
    fs.renameSync = (from,to) => { if (to === ${JSON.stringify(store)}) throw Object.assign(new Error('fake denied'), {code:'EACCES'}); return rename(from,to) };
    syncBuiltinESMExports();
    globalThis.fetch = async () => { throw new Error('real network forbidden') };
  `)
  for (const args of [['logout', 'claude'], ['forget', 'claude', 'old@example.test'], ['use', 'claude', 'reserve']]) {
    write({ claude: { default: 'old@example.test', accounts: { 'old@example.test': old, reserve: { ...old, emailAddress: 'reserve' } } } })
    const result = spawnSync(process.execPath, ['--import', preload, bot, 'login', ...args, '--json'], { env: { ...process.env }, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 1, result.stderr)
    assert.equal(JSON.parse(result.stdout).code, 'permission_denied')
    assert.equal(existsSync(`${store}.lock`), false)
  }
})

// #1430 round 2: the bot reads hybrid and nested entries with the plugin's rule — a usable
// session beats an unusable row at any depth, an unusable row only fills a free key, among
// usable copies the later expiresAt wins and the outer copy a tie. withAccountSession reads
// the entry through storeAccounts and returns it flat, so it shows what the bot made of it.
const { createHash } = await import('node:crypto')
const FRESH = now + 86_400_000
const GK = 'k@grok.test'
const grokRow = (n, expiresAt = FRESH, extra = {}) => ({ accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresAt, account: GK, ...extra })
const BROKEN = { accessToken: '', refreshToken: 'rt-broken', expiresAt: FRESH, account: GK }
const flatten = (entry, provider = 'grok') => withAccountSession(entry, 'probe@x.test', { accessToken: 'probe', refreshToken: 'probe', expiresAt: 1 }, provider)
const anon = refreshToken => `token-${createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)}`

await check('bot: a usable bare session beats an unusable row filed under the same key', async () => {
  const flat = flatten({ ...grokRow(7), default: GK, accounts: { [GK]: BROKEN } })
  assert.equal(flat.accounts[GK].accessToken, 'at-7')
})

await check('bot: a usable session beats an unusable row at the same key one level down', async () => {
  const flat = flatten({ default: GK, accounts: { [GK]: { ...grokRow(7), default: GK, accounts: { [GK]: BROKEN } } } })
  assert.equal(flat.accounts[GK].accessToken, 'at-7')
})

await check('bot: a null row in a nested accounts map does not remove the usable session', async () => {
  const flat = flatten({ default: GK, accounts: { [GK]: { ...grokRow(7), accounts: { [GK]: null } } } })
  assert.equal(flat.accounts[GK].accessToken, 'at-7')
})

await check('bot: a usable session found deeper replaces an unusable row already filed under its key', async () => {
  const flat = flatten({ default: 'o@grok.test', accounts: { [GK]: BROKEN, 'o@grok.test': { ...grokRow(5, FRESH, { account: 'o@grok.test' }), accounts: { [GK]: grokRow(8) } } } })
  assert.equal(flat.accounts[GK].accessToken, 'at-8')
  assert.equal(flat.accounts['o@grok.test'].accessToken, 'at-5')
})

await check('bot: unusable rows are kept when no usable session holds their key', async () => {
  const flat = flatten({ ...grokRow(7), default: GK, accounts: { 'n@grok.test': null, 'b@grok.test': { accessToken: '', refreshToken: 'x', expiresAt: 1 } } })
  assert.equal(flat.accounts['n@grok.test'], null)
  assert.equal(flat.accounts['b@grok.test'].refreshToken, 'x')
  assert.equal(flat.accounts[GK].accessToken, 'at-7')
})

await check('bot: a hybrid codex entry is one account keyed by workspace and user, the latest token the default', async () => {
  const idToken = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1', chatgpt_user_id: 'u-1' } })).toString('base64url')}.fake`
  const triple = JSON.stringify(['acc-1', 'user', 'u-1'])
  const row = (n, expiresAt) => ({ accessToken: `cx-${n}`, refreshToken: `cr-${n}`, expiresAt, accountId: 'acc-1', idToken })
  const flat = withAccountSession({ ...row(2, FRESH), default: triple, accounts: { [triple]: row(1, FRESH - 600_000) } }, 'probe', { accessToken: 'p', refreshToken: 'p', expiresAt: 1 }, 'codex')
  assert.deepEqual(Object.keys(flat.accounts).sort(), [triple, 'probe'].sort())
  assert.equal(flat.default, triple)
  assert.equal(flat.accounts[triple].accessToken, 'cx-2')
})

await check('bot: a bare session newer than the stray default of a hybrid entry names the default', async () => {
  const flat = flatten({ ...grokRow(9), default: 'o@grok.test', accounts: { 'o@grok.test': grokRow(5, FRESH - 600_000, { account: 'o@grok.test' }) } })
  assert.equal(flat.default, GK)
})

await check('bot: a stray default not older than the bare session keeps the default', async () => {
  const flat = flatten({ ...grokRow(9), default: 'o@grok.test', accounts: { 'o@grok.test': grokRow(5, FRESH + 600_000, { account: 'o@grok.test' }) } })
  assert.equal(flat.default, 'o@grok.test')
})

await check('bot: 122 levels of an account-less session are one account, the outermost token the default', async () => {
  const at = i => ({ accessToken: `at-${i}`, refreshToken: `rt-${i}`, expiresAt: FRESH - i * 60_000 })
  let record = at(121)
  for (let i = 120; i >= 0; i--) record = { ...at(i), default: anon(at(i + 1).refreshToken), accounts: { [anon(at(i + 1).refreshToken)]: record } }
  const flat = flatten(record)
  assert.deepEqual(Object.keys(flat.accounts).filter(key => key !== 'probe@x.test'), [anon('rt-0')])
  assert.equal(flat.default, anon('rt-0'))
  assert.equal(flat.accounts[anon('rt-0')].accessToken, 'at-0')
})

await check('bot: two usable copies of one account with the same expiry: the outer copy wins', async () => {
  const flat = flatten({ default: GK, accounts: { [GK]: { ...grokRow(1, FRESH), accounts: { [GK]: grokRow(2, FRESH) } } } })
  assert.equal(flat.accounts[GK].accessToken, 'at-1')
})

await check('bot: an account-less hybrid entry with several accounts keeps each of them', async () => {
  const at = n => ({ accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresAt: FRESH })
  const flat = flatten({ ...at(1), accounts: { [anon('rt-2')]: at(2), [anon('rt-3')]: at(3) } })
  assert.deepEqual(Object.keys(flat.accounts).filter(key => key !== 'probe@x.test').sort(), [anon('rt-1'), anon('rt-2'), anon('rt-3')].sort())
})

await check('bot: the fleet host shape (accounts level holding a 122-level hybrid) becomes one flat account', async () => {
  let record = grokRow(121, FRESH - 121 * 60_000)
  for (let i = 120; i >= 0; i--) record = { ...grokRow(i, FRESH - i * 60_000), default: GK, accounts: { [GK]: record } }
  const flat = flatten({ default: GK, accounts: { [GK]: record } })
  assert.deepEqual(Object.keys(flat.accounts).sort(), [GK, 'probe@x.test'].sort())
  assert.equal(flat.default, GK)
  assert.equal(flat.accounts[GK].accessToken, 'at-0')
})

console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
