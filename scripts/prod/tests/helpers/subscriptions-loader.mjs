// Offline mode replaces peer interfaces; the published plugin is imported unchanged.
const peers = new Set([
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-tools',
  'undici',
])

/** Route the complete plugin's peers to local test doubles. */
export async function resolve(specifier, context, nextResolve) {
  if (peers.has(specifier)) {
    return { url: new URL('./subscriptions-peer-stubs.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
