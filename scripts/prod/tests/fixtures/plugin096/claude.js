// Source excerpts: dsh-plugin-subscriptions@0.9.6, lib/providers/claude.js.
// MIT, Copyright (c) 2026 V1ki. See README.md and LICENSE in this directory.
export const CLAUDE_CLI_FALLBACK_VERSION = '2.1.283';
export function claudeCliUserAgent(version) {
    return `claude-cli/${version} (external, cli)`;
}

// Request excerpts; response mapping and other plugin dependencies omitted.
// fetchClaudeUsage:
// const userAgent = claudeCliUserAgent(await cliVersion());
// const response = await fetchFn(CLAUDE_USAGE_URL, {
//     headers: {
//         'authorization': `Bearer ${session.accessToken}`,
//         'anthropic-beta': 'oauth-2025-04-20',
//         'user-agent': userAgent,
//         'accept': 'application/json',
//     },
//     ...signal === undefined ? {} : { signal },
// });
// refreshClaude:
// const response = await proxiedFetch(CLAUDE_TOKEN_URL, {
//     method: 'POST',
//     headers: { 'content-type': 'application/json' },
//     body: JSON.stringify({ /* refresh grant omitted */ }),
// });
// fetchClaudeProfile:
// const response = await proxiedFetch(CLAUDE_PROFILE_URL, {
//     headers: { authorization: `Bearer ${accessToken}` },
// });
