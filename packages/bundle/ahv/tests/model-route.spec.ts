import { describe, expect, it } from 'vitest'
import { apply, Config, internals } from '../src/bot-runner.ts'

/**
 * `ahv run --model X` must route the model request to X. The runner couples a
 * selection to the Agent through `installModelSelection`, whose `agent/request`
 * listener overwrites the request's provider/model; handing it the default
 * selection sent every turn to the default route while `session_meta` named X.
 */

type Listener = (...args: never[]) => unknown

const DEFAULT = { provider: 'ahv-router', model: 'ahv-qwen38', reasoningEffort: 'high' }

/** Run one turn over fakes and return the request config the Agent would send. */
async function requestConfig(model: string | undefined): Promise<Record<string, unknown>> {
  const agentListeners = new Map<string, Listener>()
  const agentCtx = {
    on: (name: string, listener: Listener) => {
      agentListeners.set(name, listener)
      return () => {}
    },
  }
  let request: Record<string, unknown> = {}
  const session = { header: { id: 'bot-session-1', cwd: '/tmp' }, seq: 0 }
  const agent = {
    session,
    status: 'idle',
    whenIdle: () => Promise.resolve(),
    followup: () => {},
  }
  const create = async (options: { setup: (ctx: never) => void }) => {
    options.setup(agentCtx as never)
    const call = <T>(name: string, ...args: unknown[]) => (agentListeners.get(name) as (...a: unknown[]) => Promise<T>)(...args)
    await call('system-prompt/assemble', {}, {}, () => Promise.resolve({ variables: {} }))
    request = await call<Record<string, unknown>>('agent/request', {}, () => Promise.resolve({ provider: 'from-agent-options', model: 'unused', maxTokens: 64000 }))
    return { agent }
  }
  await new Promise<number>((resolve) => {
    const services: Record<string, unknown> = {
      appExit: resolve,
      agents: { create },
      agentDefaultModel: { currentSelection: () => DEFAULT },
      sessions: { flush: () => Promise.resolve() },
      llm: {
        listProviders: () => [{ id: 'ahv-router' }, { id: 'claude' }],
        listModels: (id: string) => Promise.resolve(id === 'claude' ? [{ id: 'claude-haiku-5-5' }] : [{ id: 'ahv-qwen38' }]),
      },
    }
    const ctx = { get: (name: string) => services[name], on: () => () => {} } as never
    internals.stdout = { write: () => true }
    internals.stderr = { write: () => true }
    apply(ctx, Config({ prompt: 'hi', cwd: '/tmp', ...model === undefined ? {} : { model }, output: 'jsonl', noColor: true, noBanner: true, systemSuffix: '' }))
  })
  return request
}

describe('bot-runner model routing', () => {
  it('sends the request to the --model route', async () => {
    const config = await requestConfig('claude-haiku-5-5')
    expect(config).toMatchObject({ provider: 'claude', model: 'claude-haiku-5-5', maxTokens: 64000 })
    expect(config).not.toHaveProperty('reasoningEffort')
  })

  it('keeps the default route and its effort without --model', async () => {
    expect(await requestConfig(undefined)).toMatchObject(DEFAULT)
  })
})
