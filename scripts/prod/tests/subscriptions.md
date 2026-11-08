# Subscriptions auth smoke

The [patch](../../../patches/dsh-plugin-subscriptions.patch) protects the plugin's exported main runtime. The smoke runs the public npm plugin itself, with fake token endpoints and temporary `HOME` and `DSH_HOME` set before import. The optional peer loader supplies missing workspace interfaces; plugin parsing, refresh, filesystem operations, providers and RPC remain real. It blocks outbound sockets and credential or CLI subprocesses. A built-tree smoke without that loader remains the release check.

Given an extracted `dsh-plugin-subscriptions@0.9.12` tarball whose integrity matches `pnpm-lock.yaml`, apply the patch with `patch -p1 -d <plugin-dir> -i "$PWD/patches/dsh-plugin-subscriptions.patch"`, then run:

```sh
node --import ./scripts/prod/tests/helpers/subscriptions-register.mjs scripts/prod/tests/test-subscriptions-keep-session.mjs --plugin <plugin-dir>
node scripts/prod/tests/test-subscriptions-mutations.mjs <plugin-dir>
node scripts/prod/tests/test-bot-auth-store.mjs
node scripts/prod/tests/test-bot-auth-store-mutations.mjs
node scripts/prod/tests/test-subscriptions-bot-interop.mjs <plugin-dir>
```

`refreshTokenExpiresAt` uses epoch milliseconds. OAuth token responses supply it through a finite, nonnegative `refresh_token_expires_in`; an unusable or absent lifetime leaves it unknown. Refresh preserves an existing deadline when the issuer supplies no replacement. Claude credential imports and bound writeback preserve supplied deadlines. No provider-wide refresh lifetime is assumed; Copilot's short access-token expiry does not imply a GitHub OAuth-token expiry.

Cooperating writers acquire the atomic directory `auth.json.lock` around the complete read, mutation and atomic replacement, including legacy migration. Refresh holds `auth.json.refresh-<provider>.lock` around reload, exchange and a token comparison before saving. Provider locks serialize accounts of that provider and are acquired before the store lock. Logout can complete while an exchange is pending; a late result cannot recreate an absent account or replace changed access or refresh tokens. Failed exchanges recheck the stored account before using an access-token fallback.

The AHV bot's import, account selection, forget, logout and persistent refresh paths use the same locks. Imports merge into a reread store after profile lookup, while a concurrent replacement login or provider logout supersedes the pending import. Refresh compares both attempted tokens before saving, and error paths wait for all scheduled account work to settle before exiting so sibling operations release their locks. The interoperability test runs the full plugin and bot in separate processes against one temporary store.

Lock directories use mode `0700`; `owner.json` contains the owner PID with mode `0600`. Contention polls every 25 ms and fails after 30 seconds. Owners release locks when operations settle. A killed owner can leave a lock behind: inspect its PID and stop its owner before removing that directory manually. Locks are never removed automatically based on age. Every writer of the shared store must follow this protocol.
