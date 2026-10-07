import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { apply, Config, internals } from '../src/bot-runner.ts'

/**
 * `ahv run --system-file F` hands F's text to the bot runner as `systemSuffix`.
 * It is the caller's data, not a template: `{{…}}` in it must reach the model
 * byte for byte instead of being substituted or failing every model step.
 */
const SAMPLES = [
  'Dùng {{model}} ở đây',
  'Ví dụ {{ten}} rồi',
  'Mẫu JSON {"a":{"b":{{1}}}}',
  'Mở {{ mà không đóng',
  'Chỉ đóng }} lẻ',
  '{{{{model}}}} {{}} }}{{',
]

/** A root context with the real prompt registry and the variables a session registers. */
async function promptContext() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Model {{model}}.' })
  ctx.systemPrompt.variable('model', () => 'ahv-qwen38')
  ctx.systemPrompt.variable('cwd', () => '/tmp/x')
  return ctx
}

/**
 * Mount the runner far enough to register its prompt section. The turn itself
 * fails on the missing services, which this test does not need.
 */
function mountRunner(ctx: Context, systemSuffix: string) {
  const stub = {
    get: (name: string) => (name === 'appExit' ? () => {} : undefined),
    systemPrompt: ctx.systemPrompt,
  } as unknown as Context
  const sink = { write: () => true }
  const saved = { stdout: internals.stdout, stderr: internals.stderr }
  internals.stdout = sink; internals.stderr = sink
  try {
    apply(stub, Config({ prompt: 'hi', cwd: '/tmp/x', output: 'jsonl', noColor: true, noBanner: true, systemSuffix }))
  } finally {
    Object.assign(internals, saved)
  }
}

describe('bot-runner systemSuffix', () => {
  for (const text of SAMPLES) {
    it(`reaches the prompt verbatim: ${text}`, async () => {
      const ctx = await promptContext()
      mountRunner(ctx, text)
      const prompt = renderPrompt(await ctx.systemPrompt.assemble({}))
      expect(prompt.endsWith(`\n\n${text}`)).toBe(true)
      // The deployment persona keeps interpolating.
      expect(prompt).toContain('Model ahv-qwen38.')
    })
  }

  it('adds nothing without a system file', async () => {
    const ctx = await promptContext()
    const before = renderPrompt(await ctx.systemPrompt.assemble({}))
    mountRunner(ctx, '')
    expect(renderPrompt(await ctx.systemPrompt.assemble({}))).toBe(before)
  })
})
