// Quota for every account, not only the one in use.
//
// A machine can hold several logins per provider, and only the default was ever
// asked — so the console showed one number, belonging to one account, with no
// way to see what the others had left. That is the wrong way round: the moment
// you need to know is when the account in use has just run out.
//
// The build machine holds exactly one account per provider, so the case that
// matters — two accounts, one of them spent — cannot be produced by logging in
// here. It is driven with a stub fetch instead.
import assert from 'node:assert/strict'

const { collectSubscriptionUsage, withAccountSession } =
  await import('/home/claudeproxy/Claude/AHVclaw-fork/scripts/prod/ahv-bot.mjs')

let passed = 0, failed = 0
async function acheck(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++ }
}

const LIVE = Date.now() + 3_600_000

/** Two Claude accounts: the one in use is nearly spent, the reserve is fresh. */
const TWO_ACCOUNTS = {
  claude: {
    default: 'spent@x.com',
    accounts: {
      'spent@x.com': { accessToken: 'tok-spent', refreshToken: 'r1', expiresAt: LIVE, emailAddress: 'spent@x.com' },
      'reserve@x.com': { accessToken: 'tok-reserve', refreshToken: 'r2', expiresAt: LIVE, emailAddress: 'reserve@x.com' },
    },
  },
}

/** Answers each account's usage call with a percentage keyed off its token. */
function usageFetch(byToken) {
  return async (url, init) => {
    const auth = String(init?.headers?.authorization ?? '')
    const token = auth.replace('Bearer ', '')
    if (!(token in byToken)) throw new Error(`unexpected token ${token}`)
    return { ok: true, status: 200, json: async () => ({ limits: [{ kind: 'session', percent: byToken[token] }] }) }
  }
}

await acheck('every account is reported, not just the default', async () => {
  const { providers } = await collectSubscriptionUsage(TWO_ACCOUNTS, usageFetch({ 'tok-spent': 97, 'tok-reserve': 4 }))
  const rows = providers.claude.accounts
  assert.equal(rows.length, 2, JSON.stringify(rows))
  assert.deepEqual(rows.map(r => r.account).sort(), ['reserve@x.com', 'spent@x.com'])
})

await acheck('each account carries its own figures', async () => {
  const { providers } = await collectSubscriptionUsage(TWO_ACCOUNTS, usageFetch({ 'tok-spent': 97, 'tok-reserve': 4 }))
  const by = Object.fromEntries(providers.claude.accounts.map(r => [r.account, r.windows[0].used_percent]))
  assert.equal(by['spent@x.com'], 97, 'the account in use is nearly spent')
  assert.equal(by['reserve@x.com'], 4, 'the reserve has room — the whole point of showing it')
})

await acheck('the account in use is marked as such', async () => {
  const { providers } = await collectSubscriptionUsage(TWO_ACCOUNTS, usageFetch({ 'tok-spent': 97, 'tok-reserve': 4 }))
  const flagged = providers.claude.accounts.filter(r => r.is_default)
  assert.equal(flagged.length, 1, 'exactly one account is in use')
  assert.equal(flagged[0].account, 'spent@x.com')
})

await acheck('the old top-level fields still describe the account in use', async () => {
  // A console or agent that predates this reads these and must not change
  // meaning: they are the default's numbers, exactly as before.
  const { providers } = await collectSubscriptionUsage(TWO_ACCOUNTS, usageFetch({ 'tok-spent': 97, 'tok-reserve': 4 }))
  assert.equal(providers.claude.logged_in, true)
  assert.equal(providers.claude.supported, true)
  assert.equal(providers.claude.windows[0].used_percent, 97)
})

await acheck('one account failing does not hide the others', async () => {
  const fetchFn = async (url, init) => {
    const token = String(init?.headers?.authorization ?? '').replace('Bearer ', '')
    if (token === 'tok-spent') return { ok: false, status: 401, text: async () => 'expired' }
    return { ok: true, status: 200, json: async () => ({ limits: [{ kind: 'session', percent: 4 }] }) }
  }
  const { providers } = await collectSubscriptionUsage(TWO_ACCOUNTS, fetchFn)
  const by = Object.fromEntries(providers.claude.accounts.map(r => [r.account, r]))
  assert.match(by['spent@x.com'].error, /401/)
  assert.equal(by['reserve@x.com'].windows[0].used_percent, 4)
})

await acheck('a provider with no login at all reports no accounts, not a crash', async () => {
  const { providers } = await collectSubscriptionUsage({}, async () => { throw new Error('must not be called') })
  for (const kind of ['claude', 'codex', 'grok']) {
    assert.deepEqual(providers[kind].accounts, [], kind)
    assert.equal(providers[kind].logged_in, false, kind)
  }
})

await acheck('the older bare shape is still read as one account', async () => {
  const bare = { claude: { accessToken: 'tok-bare', refreshToken: 'r', expiresAt: LIVE, emailAddress: 'old@x.com' } }
  const { providers } = await collectSubscriptionUsage(bare, usageFetch({ 'tok-bare': 11 }))
  assert.equal(providers.claude.accounts.length, 1)
  assert.equal(providers.claude.accounts[0].is_default, true)
})

// ── the reserve account must keep refreshing itself ───────────────────────
//
// Asking every account for its quota means refreshing every account's token.
// The writer this replaces filed every refreshed session under whichever
// account was default, so the reserve's new token would land on the account in
// use and overwrite a session that is not its own.

await acheck('a refreshed reserve token is filed under the reserve, not the default', async () => {
  const stale = {
    claude: {
      default: 'spent@x.com',
      accounts: {
        'spent@x.com': { accessToken: 'tok-spent', refreshToken: 'r1', expiresAt: LIVE, emailAddress: 'spent@x.com' },
        'reserve@x.com': { accessToken: 'tok-reserve', refreshToken: 'r2', expiresAt: Date.now() - 1, emailAddress: 'reserve@x.com' },
      },
    },
  }
  const fetchFn = async (url, init) => {
    if (init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok-reserve-new', expires_in: 28800 }) }
    }
    return { ok: true, status: 200, json: async () => ({ limits: [{ kind: 'session', percent: 5 }] }) }
  }
  const { refreshed } = await collectSubscriptionUsage(stale, fetchFn)
  assert.equal(refreshed.length, 1, JSON.stringify(refreshed))
  assert.equal(refreshed[0].key, 'reserve@x.com', 'the token belongs to the reserve')

  const after = withAccountSession(stale.claude, refreshed[0].key, refreshed[0].session)
  assert.equal(after.accounts['reserve@x.com'].accessToken, 'tok-reserve-new')
  assert.equal(after.accounts['spent@x.com'].accessToken, 'tok-spent', 'the account in use must not be overwritten')
  assert.equal(after.default, 'spent@x.com', 'refreshing a token is not a decision to switch accounts')
})

await acheck('writing to an unnamed account changes nothing', async () => {
  const entry = { default: 'a', accounts: { a: { accessToken: 'x' } } }
  assert.deepEqual(withAccountSession(entry, '', { accessToken: 'y' }), entry)
})

// ── a Codex account has a name, not a UUID ───────────────────────────────
//
// Sessions mirrored from the Codex CLI carry only the raw token set, so a
// machine with two Codex logins listed two UUIDs — the same "which one is
// this?" problem that naming the account was meant to end. The address is
// already inside the id token.

function idTokenFor(email) {
  const claims = Buffer.from(JSON.stringify({ email })).toString('base64url')
  return `head.${claims}.sig`
}

await acheck('a codex account is named by the address in its id token', async () => {
  const store = {
    codex: {
      default: 'acct-uuid-1',
      accounts: {
        'acct-uuid-1': { accessToken: 'tok-1', refreshToken: 'r', expiresAt: LIVE, idToken: idTokenFor('one@x.com') },
        'acct-uuid-2': { accessToken: 'tok-2', refreshToken: 'r', expiresAt: LIVE, idToken: idTokenFor('two@x.com') },
      },
    },
  }
  const { providers } = await collectSubscriptionUsage(store, async () => ({
    ok: true, status: 200, json: async () => ({ rate_limit: { primary_window: { used_percent: 20 } } }),
  }))
  assert.deepEqual(providers.codex.accounts.map(r => r.account).sort(), ['one@x.com', 'two@x.com'])
})

await acheck('an account with no readable name falls back to its key, not to nothing', async () => {
  const store = { codex: { default: 'k1', accounts: { k1: { accessToken: 't', expiresAt: LIVE } } } }
  const { providers } = await collectSubscriptionUsage(store, async () => ({
    ok: true, status: 200, json: async () => ({ rate_limit: { primary_window: { used_percent: 1 } } }),
  }))
  assert.equal(providers.codex.accounts[0].account, 'k1')
})

await acheck('a malformed id token is nameless, not a crash', async () => {
  const store = { codex: { default: 'k1', accounts: { k1: { accessToken: 't', expiresAt: LIVE, idToken: 'not.a.jwt' } } } }
  const { providers } = await collectSubscriptionUsage(store, async () => ({
    ok: true, status: 200, json: async () => ({ rate_limit: { primary_window: { used_percent: 1 } } }),
  }))
  assert.equal(providers.codex.accounts[0].account, 'k1')
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
