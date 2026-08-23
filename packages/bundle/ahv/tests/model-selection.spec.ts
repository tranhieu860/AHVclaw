import { describe, expect, it } from 'vitest'
import { resolveModelSelection } from '../src/bot-runner.ts'

/**
 * A registry stub: providers that list, and providers whose listing fails.
 * @param listable - provider id → model ids it reports.
 * @param failing - provider ids that are mounted but cannot list right now.
 */
function registry(listable: Record<string, string[]>, failing: string[] = []) {
  return {
    listProviders: () => [...Object.keys(listable), ...failing].map(id => ({ id })),
    listModels: async (id: string) => {
      if (failing.includes(id)) throw new Error(`${id} unavailable`)
      return (listable[id] ?? []).map(model => ({ id: model }))
    },
  }
}

/** A context exposing only what the resolver reads. */
function contextWith(llm: unknown) {
  return { get: (name: string) => (name === 'llm' ? llm : undefined) } as never
}

const fallback = { provider: 'ahv-router', model: 'ahv-qwen38' }

describe('resolveModelSelection', () => {
  it('places a bare id on the provider that actually offers it', async () => {
    const ctx = contextWith(registry({ claude: ['claude-sonnet-4-5'], grok: ['grok-4.6'] }))
    await expect(resolveModelSelection(ctx, 'grok-4.6', fallback))
      .resolves.toEqual({ provider: 'grok', model: 'grok-4.6' })
  })

  it('accepts an explicit provider/model that the registry confirms', async () => {
    const ctx = contextWith(registry({ claude: ['claude-sonnet-4-5'] }))
    await expect(resolveModelSelection(ctx, 'claude/claude-sonnet-4-5', fallback))
      .resolves.toEqual({ provider: 'claude', model: 'claude-sonnet-4-5' })
  })

  it('refuses a provider that is not mounted instead of quietly using another', async () => {
    // The caller believes it is spending a Claude subscription. Silently
    // answering from the router hides that the subscription is not wired up.
    const ctx = contextWith(registry({ grok: ['grok-4.6'] }))
    await expect(resolveModelSelection(ctx, 'claude/claude-sonnet-4-5', fallback))
      .rejects.toThrow(/claude/)
  })

  it('refuses a bare id that no provider offers', async () => {
    const ctx = contextWith(registry({ grok: ['grok-4.6'] }))
    await expect(resolveModelSelection(ctx, 'mo-hinh-ao', fallback))
      .rejects.toThrow(/mo-hinh-ao/)
  })

  it('names what is available so the caller can correct the request', async () => {
    const ctx = contextWith(registry({ grok: ['grok-4.6'] }))
    await expect(resolveModelSelection(ctx, 'khong-ton-tai/x', fallback))
      .rejects.toThrow(/grok/)
  })

  it('does not reject when a mounted provider merely failed to list', async () => {
    // Providers drop out of the catalog intermittently. Turning that into a
    // hard rejection would fail runs for models that do exist.
    const ctx = contextWith(registry({ grok: ['grok-4.6'] }, ['claude']))
    await expect(resolveModelSelection(ctx, 'claude/claude-sonnet-4-5', fallback))
      .resolves.toEqual({ provider: 'claude', model: 'claude-sonnet-4-5' })
  })

  it('keeps a bare id when some provider could not be consulted', async () => {
    const ctx = contextWith(registry({ grok: ['grok-4.6'] }, ['claude']))
    await expect(resolveModelSelection(ctx, 'claude-sonnet-4-5', fallback))
      .resolves.toEqual({ provider: fallback.provider, model: 'claude-sonnet-4-5' })
  })

  it('stays permissive when there is no registry to check against', async () => {
    const ctx = contextWith(undefined)
    await expect(resolveModelSelection(ctx, 'anything/at-all', fallback))
      .resolves.toEqual({ provider: 'anything', model: 'at-all' })
  })
})
