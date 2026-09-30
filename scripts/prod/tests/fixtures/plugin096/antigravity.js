// Source excerpts: dsh-plugin-subscriptions@0.9.6, lib/providers/antigravity.js.
// MIT, Copyright (c) 2026 V1ki. See README.md and LICENSE in this directory.
export const ANTIGRAVITY_DEFAULT_USER_AGENT = 'antigravity/1.104.0 dsh-plugin-subscriptions';

// fetchAntigravityUsage delegates its requests to callInternal, which uses:
// antigravityHeaders:
// return {
//     'authorization': `Bearer ${accessToken}`,
//     'content-type': 'application/json',
//     'user-agent': userAgent,
// };
// refreshAntigravity:
// const response = await fetchFn(ANTIGRAVITY_TOKEN_URL, {
//     method: 'POST',
//     headers: { 'content-type': 'application/x-www-form-urlencoded' },
//     body: body.toString(),
// });
