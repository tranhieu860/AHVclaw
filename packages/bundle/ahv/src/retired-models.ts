/**
 * Retired AHV models: a request still naming one runs on its replacement.
 *
 * ahv-qwen38 existed only behind the old router on #1; AHV AI answers it with
 * model_not_found (#976). Choices made while it was served live on in places
 * this bundle does not write: a web conversation restores the model its last
 * request header recorded, and a bot passes the id it saved. The default and
 * `--model` paths map the id where they read it; this listener catches every
 * other route (resumed web and ACP sessions, subagents inheriting a parent's
 * header) at the one point every request passes.
 * @module @ahvclaw/dsh-bundle-ahv/retired-models
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'

/** Stable Cordis plugin name. */
export const name = 'ahv-retired-models'

/** The route that served the retired models. */
export const AHV_ROUTE = 'ahv-router'

/** Retired model id on {@link AHV_ROUTE} → the model a request for it runs on. */
export const RETIRED_MODELS: Readonly<Record<string, string>> = Object.freeze({ 'ahv-qwen38': 'AHV-Holding' })

/**
 * The replacement for a retired model on the AHV route, or undefined.
 * @param provider - request provider.
 * @param model - request model id.
 * @returns the model to run instead, when the pair is retired.
 */
export function retiredReplacement(provider: string, model: string): string | undefined {
  return provider === AHV_ROUTE && Object.hasOwn(RETIRED_MODELS, model) ? RETIRED_MODELS[model] : undefined
}

/**
 * Rewrite a request for a retired model just before it is sent. Registered
 * first so it wraps the per-Agent model selection and sees its final config.
 * @param ctx - root plugin context.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    const replacement = retiredReplacement(config.provider, config.model)
    return replacement === undefined ? config : { ...config, model: replacement }
  }, { prepend: true })
}
