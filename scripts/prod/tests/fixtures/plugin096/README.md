# Plugin 0.9.6 header fixtures

These minimal excerpts come from the public npm release [`dsh-plugin-subscriptions@0.9.6`](https://registry.npmjs.org/dsh-plugin-subscriptions/-/dsh-plugin-subscriptions-0.9.6.tgz), maintained at [V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions). Archive SHA-1: `5a16d6cd808c22f6709c9a95fd6c8d12f49107a0`. Retrieved on 2026-10-01 and verified against npm's SHA-512 integrity value. The original MIT license is included.

`claude.js` copies `CLAUDE_CLI_FALLBACK_VERSION` and `claudeCliUserAgent`; `antigravity.js` copies `ANTIGRAVITY_DEFAULT_USER_AGENT`. Comments retain the usage, refresh and profile request headers; request bodies, response mapping, credentials and harness imports are omitted. These are source fixtures for the drift gate, not complete provider modules.

`test-provider-headers.mjs` prefers sources from an installed plugin. When none resolves, it reads these fixtures relative to the test file, without any external `inputs` directory. Update the excerpts deliberately when adopting a new plugin release; an installed plugin with different constants or UA forms makes the gate fail.
