/**
 * ahv-bot list-models: enumerate every LLM provider currently registered in
 * the composed dsh harness — llm-pi-ai (AHV router), dsh-plugin-subscriptions
 * (ChatGPT Codex / Claude Pro / Grok Premium sau khi user OAuth login), và
 * bất cứ LLM plugin nào khác được mount. Bot đọc list này thay vì scrape
 * config file hoặc query mỗi endpoint riêng biệt.
 *
 * Runner mode: mount → await loader → cho mỗi provider gọi `listModels(id)`
 * → emit 1 JSON object trên stdout → exit 0. Không chạy prompt, không tạo
 * agent — chỉ dump catalog rồi ra.
 *
 * @module @ahvclaw/dsh-bundle-ahv/bot-list-models
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-llm'

/** Stable Cordis plugin name. */
export const name = 'bot-list-models'

/** LLM service is required to enumerate registered adapters. */
export const inject = ['llm']

/** Process-facing effects — kept as an internals seam for future tests. */
export const internals: { stdout: { write(chunk: string): unknown }; stderr: { write(chunk: string): unknown } } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

async function dump(ctx: Context, exit: (code: number) => void): Promise<void> {
  await ctx.get('loader')?.await()
  const llm = ctx.get('llm')
  if (llm === undefined) {
    internals.stderr.write('bot-list-models: ctx.llm not available (no LLM plugin mounted)\n')
    exit(1)
    return
  }

  const providers = llm.listProviders()
  const catalog: Array<{
    provider: string
    provider_name: string
    model_id: string
    model_name: string | undefined
    context_window: number | undefined
    max_tokens: number | undefined
  }> = []

  for (const p of providers) {
    let models: readonly unknown[] = []
    try {
      models = await llm.listModels(p.id)
    } catch (error) {
      internals.stderr.write(`bot-list-models: listModels(${p.id}) failed: ${String(error)}\n`)
    }
    for (const raw of models) {
      const m = raw as { id?: string; name?: string; contextWindow?: number; maxTokens?: number }
      if (typeof m.id !== 'string') continue
      catalog.push({
        provider: p.id,
        provider_name: p.name,
        model_id: m.id,
        model_name: m.name,
        context_window: m.contextWindow,
        max_tokens: m.maxTokens,
      })
    }
  }

  const payload = {
    provider_count: providers.length,
    model_count: catalog.length,
    providers: providers.map(p => ({ id: p.id, name: p.name })),
    models: catalog,
  }
  internals.stdout.write(JSON.stringify(payload) + '\n')
  // stdout là process.stdout mặc định — write sync cho pipe khi < 64KB, còn
  // hơn thế bot chạy qua tsx spawn buffer riêng. Delay 10ms an toàn cho
  // flush kernel pipe trước khi exit dispose cả tree.
  setTimeout(() => exit(0), 10)
}

export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('bot-list-models: the launcher must provide ctx.appExit before the tree mounts')
  }
  void dump(ctx, exit).catch((error: unknown) => {
    internals.stderr.write(`bot-list-models: ${String(error)}\n`)
    exit(1)
  })
}
