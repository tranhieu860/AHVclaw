// Test-only peers for running the complete published plugin without a workspace build.
// Auth parsing, persistence, provider refreshes, and RPC dispatch stay in the plugin.
import { join } from 'node:path'

// Config is declared at import time but the smoke invokes apply() with resolved config.
const schema = new Proxy(function () {}, {
  get: (_target, key) => key === 'then' ? undefined : schema,
  apply: () => schema,
})
export default schema

/** Runtime base of provider adapters; all exercised methods belong to the plugin. */
export class LlmAdapter {}

/** Preserve the error fields the plugin and its consumer exchange. */
export class LlmError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'LlmError'
    this.code = code
    this.failure = { message, code }
  }
}

export const WebError = LlmError
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED'
export const ReasoningEffortId = value => value
export const AttachmentId = value => value
export const attributionHeaders = () => ({})
export const isContextWindowExceededError = error => error?.code === CONTEXT_WINDOW_EXCEEDED_CODE
export const isQuotaExceededError = error => error?.code === QUOTA_EXCEEDED_CODE
export const resolveRetryPolicy = policy => policy
export const defineTool = tool => tool
export const errorChain = error => error instanceof Error
  ? `${error.message}${error.cause ? `: ${errorChain(error.cause)}` : ''}`
  : String(error)

/** Resolve only the test's explicit store; never fall back to the host's home. */
export function dshHomePath(...parts) {
  if (!process.env.DSH_HOME) throw new Error('subscriptions test requires fixture DSH_HOME')
  return join(process.env.DSH_HOME, ...parts)
}

/** A proxy path is unexpected in the offline smoke. */
export class ProxyAgent {
  constructor() { throw new Error('subscriptions test cannot create a network proxy') }
}

/** Undici requests must use the test's endpoint double. */
export const fetch = (...args) => globalThis.fetch(...args)
