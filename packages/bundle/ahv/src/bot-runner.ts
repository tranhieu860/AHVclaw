/**
 * ahv-bot runner: the JSONL streamer that Telegram bot integrations consume.
 * Subscribes to the core `session/event` bus, translates each `SessionEvent`
 * into the bot's public JSONL taxonomy on `stdout`, and drives one prompt
 * against a caller-identified session (create-by-id, resume-by-id, or fresh).
 *
 * Exit contract mirrors the bot spec:
 *   0  = completed, `assistant_final` + `turn_end/completed` emitted
 *   1  = terminal user-action (missing_credential, quota_limit, permission_denied)
 *   2  = recoverable/transient (rate_limit, network_transient, model_unavailable)
 *   124 = SIGTERM/SIGINT (bot-side cancel)
 *
 * @module @ahvclaw/dsh-bundle-ahv/bot-runner
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'bot-runner'

/** Core services required before the bot turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'botStartup']

/** Runner config: everything the bot-startup provider resolved. */
export interface Config {
  readonly prompt: string
  readonly cwd: string
  readonly sessionId?: string | null
  readonly resumeSessionId?: string | null
  readonly output: 'jsonl' | 'text'
  readonly noColor: boolean
  readonly noBanner: boolean
}

export const Config: z<Config> = z.object({
  prompt: z.string().required(),
  cwd: z.string().required(),
  sessionId: z.string(),
  resumeSessionId: z.string(),
  output: z.union([z.const('jsonl' as const), z.const('text' as const)]).default('jsonl'),
  noColor: z.boolean().default(true),
  noBanner: z.boolean().default(true),
})

/** Bot public JSONL event taxonomy. */
type BotEvent =
  | { type: 'session_meta'; session_id: string; cwd: string; model: string; resumed: boolean }
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_status'; name: string; status: 'running' | 'ok' | 'error'; summary: string }
  | { type: 'assistant_final'; text: string }
  | { type: 'turn_end'; reason: 'completed' | 'stopped' | 'error'; usage: { input_tokens: number; output_tokens: number } }
  | { type: 'error'; code: BotErrorCode; terminal: boolean; retry_after_sec: number; message: string }

/** Machine-parseable error codes bot dispatchers rely on. */
type BotErrorCode =
  | 'missing_credential'
  | 'not_logged_in'
  | 'quota_limit'
  | 'rate_limit'
  | 'network_transient'
  | 'model_unavailable'
  | 'context_too_large'
  | 'permission_denied'
  | 'tool_error'
  | 'internal_error'

interface BotIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

export const internals: { stdout: BotIo['stdout']; stderr: BotIo['stderr'] } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Emit one JSONL event to stdout with a trailing newline. */
function emit(io: BotIo, event: BotEvent): void {
  io.stdout.write(JSON.stringify(event) + '\n')
}

/**
 * Map a raw error to a bot taxonomy code. The order matters — check for
 * credential/network failures BEFORE generic 5xx, since router-side errors
 * often surface as fetch failures that the bot classifies as recoverable.
 */
function classifyError(error: unknown): { code: BotErrorCode; terminal: boolean; retryAfterSec: number; message: string } {
  const raw = error instanceof Error ? error.message : String(error)
  const lower = raw.toLowerCase()

  if (lower.includes('missing credential') || lower.includes('apikeyenv') || lower.includes('ahv_api_key')) {
    return { code: 'missing_credential', terminal: true, retryAfterSec: 0, message: 'Missing AHV_API_KEY — set env or credential file' }
  }
  if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('invalid api key')) {
    return { code: 'not_logged_in', terminal: true, retryAfterSec: 0, message: 'Auth rejected — key invalid or expired' }
  }
  if (lower.includes('quota') || lower.includes('402') || lower.includes('billing')) {
    return { code: 'quota_limit', terminal: true, retryAfterSec: 0, message: 'Quota exhausted — top up account' }
  }
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
    return { code: 'rate_limit', terminal: false, retryAfterSec: 30, message: 'Rate limited — retry after backoff' }
  }
  if (lower.includes('econnrefused') || lower.includes('etimedout') || lower.includes('enotfound') || lower.includes('fetch failed')) {
    return { code: 'network_transient', terminal: false, retryAfterSec: 5, message: 'Network fault — retry' }
  }
  if (lower.includes('model_not_found') || lower.includes('model unavailable') || lower.includes('503') || lower.includes('502')) {
    return { code: 'model_unavailable', terminal: false, retryAfterSec: 15, message: 'Model temporarily unavailable — retry' }
  }
  if (lower.includes('context_length_exceeded') || lower.includes('token limit') || lower.includes('too long')) {
    return { code: 'context_too_large', terminal: true, retryAfterSec: 0, message: 'Context exceeded model window — start new session' }
  }
  if (lower.includes('eacces') || lower.includes('permission denied') || lower.includes('403')) {
    return { code: 'permission_denied', terminal: true, retryAfterSec: 0, message: 'Permission denied' }
  }
  return { code: 'internal_error', terminal: true, retryAfterSec: 0, message: `Internal: ${raw}` }
}

/** Convert a core SessionEvent → optional bot JSONL event (returns null for events with no external analog). */
function translate(event: SessionEvent): BotEvent | null {
  if (event.type === 'assistant/message') {
    const text = event.data.message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text === '') return null
    return { type: 'assistant_final', text }
  }
  if (event.type === 'assistant/chunk') {
    const data = event.data as { block?: { type?: string; text?: string } }
    if (data.block?.type === 'text' && typeof data.block.text === 'string' && data.block.text !== '') {
      return { type: 'assistant_delta', text: data.block.text }
    }
    return null
  }
  if (event.type === 'tool/call') {
    const data = event.data as { tool?: { name?: string }; name?: string }
    const toolName = data.tool?.name ?? data.name ?? 'unknown'
    return { type: 'tool_status', name: toolName, status: 'running', summary: '' }
  }
  if (event.type === 'tool/result') {
    const data = event.data as { tool?: { name?: string }; name?: string; error?: unknown }
    const toolName = data.tool?.name ?? data.name ?? 'unknown'
    return { type: 'tool_status', name: toolName, status: data.error === undefined ? 'ok' : 'error', summary: '' }
  }
  if (event.type === 'turn/end') {
    const data = event.data as { reason?: { kind?: string }; usage?: { inputTokens?: number; outputTokens?: number } }
    const kind = data.reason?.kind ?? 'completed'
    return {
      type: 'turn_end',
      reason: kind === 'completed' ? 'completed' : (kind === 'error' ? 'error' : 'stopped'),
      usage: {
        input_tokens: data.usage?.inputTokens ?? 0,
        output_tokens: data.usage?.outputTokens ?? 0,
      },
    }
  }
  return null
}

/** Report a runner failure through the bot JSONL taxonomy and pick the exit code. */
function fail(io: BotIo, error: unknown, output: 'jsonl' | 'text'): void {
  const c = classifyError(error)
  if (output === 'jsonl') {
    emit(io, { type: 'error', code: c.code, terminal: c.terminal, retry_after_sec: c.retryAfterSec, message: c.message })
  } else {
    io.stderr.write(`ahv-bot: ${c.code}: ${c.message}\n`)
  }
  io.exit(c.terminal ? 1 : 2)
}

/**
 * Drive one prompt to quiescence and emit the JSONL stream.
 * @param ctx - plugin context carrying agents, default model, sessions, session bus.
 * @param config - resolved bot config (prompt + session identity).
 * @param io - process-facing effects.
 */
async function run(ctx: Context, config: Config, io: BotIo): Promise<void> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  const resumeId = config.resumeSessionId != null && config.resumeSessionId !== '' ? config.resumeSessionId : undefined
  const explicitId = config.sessionId != null && config.sessionId !== '' ? config.sessionId : undefined
  const targetId = resumeId ?? explicitId ?? `bot-session-${randomUUID()}`
  const resumed = resumeId !== undefined

  // Subscribe to session events BEFORE creating the agent so we catch every append.
  // Track final turn outcome + saw-assistant-final flag so we can decide the
  // exit code + emit a bot `error` event when the turn ends with reason=error
  // (session/persistence load fail, model tool loop trapped, etc). Without this
  // adapter would silently exit 0 with turn_end reason=error and no
  // assistant_final — bot would classify as "completed with empty answer".
  const emitLock = { session: undefined as Session | undefined }
  const turnState = {
    lastTurnEndReason: null as { kind: string; error?: { code?: string; message?: string } } | null,
    sawAssistantFinal: false,
  }
  const dispose = ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (emitLock.session !== undefined && session.header.id !== emitLock.session.header.id) return
    if (event.type === 'turn/end') {
      const data = event.data as { reason?: { kind: string; error?: { code?: string; message?: string } } }
      turnState.lastTurnEndReason = data.reason ?? null
    }
    if (event.type === 'assistant/message') {
      const hasText = event.data.message.content.some((b): b is { type: 'text'; text: string } => b.type === 'text' && b.text !== '')
      if (hasText) turnState.sawAssistantFinal = true
    }
    const translated = translate(event)
    if (translated === null) return
    if (config.output === 'jsonl') emit(io, translated)
  })

  try {
    const setup = (agentCtx: Context) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    }
    const { agent } = resumed
      ? await agents.resume({
          resumeSessionId: SessionId(targetId),
          agentOptions: { provider: selection.provider, model: selection.model },
          setup,
        })
      : await agents.create({
          sessionId: SessionId(targetId),
          meta: { cwd: config.cwd },
          agentOptions: { provider: selection.provider, model: selection.model },
          setup,
        })

    emitLock.session = agent.session
    if (config.output === 'jsonl') {
      emit(io, {
        type: 'session_meta',
        session_id: agent.session.header.id,
        cwd: agent.session.header.cwd ?? config.cwd,
        model: selection.model,
        resumed,
      })
    }
    await agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: config.prompt }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await sessions.flush(agent.session)

    // Text mode: also print the last assistant text for backwards compat.
    if (config.output === 'text') {
      const lastAssistantText = [...agent.session.events]
        .reverse()
        .find(e => e.type === 'assistant/message')
      if (lastAssistantText?.type === 'assistant/message') {
        const text = lastAssistantText.data.message.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => b.text)
          .join('')
        io.stdout.write(text + '\n')
      }
    }

    // Exit code contract: turn_end reason=completed + có assistant_final →
    // exit 0. Bất kỳ trạng thái nào khác (turn/end reason=error, agent-loop
    // dừng vì tool crash, resume corrupted session, ...) emit bot error
    // event + non-zero exit để bot phân loại terminal vs recoverable.
    if (turnState.lastTurnEndReason?.kind === 'error') {
      const err = turnState.lastTurnEndReason.error
      if (config.output === 'jsonl') {
        emit(io, {
          type: 'error',
          code: 'tool_error',   // agent-loop reason=error covers tool + provider mid-turn failures
          terminal: false,      // safe default: bot retry với backoff
          retry_after_sec: 5,
          message: err?.message ?? err?.code ?? 'turn ended with reason=error (no message)',
        })
      } else {
        io.stderr.write(`ahv-bot: tool_error: ${err?.message ?? err?.code ?? 'unknown'}\n`)
      }
      io.exit(2)
      return
    }
    if (!turnState.sawAssistantFinal && config.output === 'jsonl') {
      // Turn kết thúc completed nhưng model không trả text (rare — tool-only
      // turn hoặc empty reply). Bot cần phân biệt vs "success + có câu trả
      // lời", nên emit error stopped để bot handle.
      emit(io, {
        type: 'error',
        code: 'internal_error',
        terminal: true,
        retry_after_sec: 0,
        message: 'turn completed nhưng không có assistant_final message',
      })
      io.exit(1)
      return
    }
    io.exit(0)
  } finally {
    dispose()
  }
}

/**
 * Mount the bot runner.
 * @param ctx - plugin context with the launcher's appExit + core services.
 * @param config - validated bot config resolved from botStartup.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('bot-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: BotIo = { stdout: internals.stdout, stderr: internals.stderr, exit }

  const abortHandler = () => io.exit(124)
  process.once('SIGTERM', abortHandler)
  process.once('SIGINT', abortHandler)

  void run(ctx, config, io).catch((error: unknown) => { fail(io, error, config.output) })
}
