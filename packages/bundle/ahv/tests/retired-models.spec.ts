import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as RetiredModels from '../src/retired-models.ts'

/**
 * A web conversation restores the model its last request header recorded, so
 * one started on ahv-qwen38 keeps asking AHV AI for it and gets
 * model_not_found (#976). The bundle listener rewrites the request after the
 * per-Agent selection has applied its route, whichever was registered first.
 */
const SIGNAL = new AbortController().signal
const SEED: LlmCallConfig = { provider: 'from-agent-options', model: 'unused', maxTokens: 64000 }

interface Selected { provider: string; model: string; reasoningEffort?: string }

async function request(selected: Selected, pluginFirst: boolean): Promise<LlmCallConfig> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  if (pluginFirst) await ctx.plugin(RetiredModels)
  const { reasoningEffort, ...route } = selected
  const selection: ModelSelectionRef = {
    current: reasoningEffort === undefined ? route : { ...route, reasoningEffort: ReasoningEffortId(reasoningEffort) },
    assembled: undefined,
  }
  installModelSelection(ctx, selection)
  if (!pluginFirst) await ctx.plugin(RetiredModels)
  await ctx.systemPrompt.assemble()
  const agent = { session: Session.create(SessionId('retired-models')) } as Agent
  const config = await agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 0, signal: SIGNAL }, () => Promise.resolve(SEED))
  await ctx.fiber.dispose()
  return config
}

describe('retired AHV models', () => {
  it('sends a restored ahv-router/ahv-qwen38 conversation to AHV-Holding, keeping the rest of the request', async () => {
    for (const pluginFirst of [true, false]) {
      await expect(request({ provider: 'ahv-router', model: 'ahv-qwen38', reasoningEffort: 'high' }, pluginFirst))
        .resolves.toEqual({ provider: 'ahv-router', model: 'AHV-Holding', reasoningEffort: 'high', maxTokens: 64000 })
    }
  })

  it('leaves every other route alone', async () => {
    await expect(request({ provider: 'ahv-router', model: 'AHV-Holding-TroLy' }, true))
      .resolves.toEqual({ provider: 'ahv-router', model: 'AHV-Holding-TroLy', maxTokens: 64000 })
    await expect(request({ provider: 'grok', model: 'ahv-qwen38' }, true))
      .resolves.toEqual({ provider: 'grok', model: 'ahv-qwen38', maxTokens: 64000 })
  })

  it('knows only the retired ids', () => {
    expect(RetiredModels.retiredReplacement('ahv-router', 'ahv-qwen38')).toBe('AHV-Holding')
    expect(RetiredModels.retiredReplacement('ahv-router', 'toString')).toBeUndefined()
    expect(RetiredModels.retiredReplacement('claude', 'ahv-qwen38')).toBeUndefined()
  })
})
