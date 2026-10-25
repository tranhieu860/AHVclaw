import { describe, expect, it } from 'vitest'
import { apply, Config, internals } from '../src/bot-runner.ts'

/**
 * dsh 0.2.1 delegations return an activation at once; the child's answer
 * arrives later as a completion notice that starts another parent turn. The
 * runner must keep waiting while `subagents.waitForChildren` joins work, and a
 * live `agent/error` without a later turn/end must fail the run.
 */

type Listener = (...args: never[]) => void

interface Harness {
  readonly agent: object
  emitTurn(text: string): void
  emit(name: string, ...args: unknown[]): void
}

/** Mount the runner over fakes; `script` drives the parent and its children. */
async function runBot(script: {
  followup: (h: Harness) => void
  waitForChildren?: (h: Harness, call: number) => boolean
}): Promise<{ code: number; stdout: string }> {
  const listeners = new Map<string, Listener[]>()
  const session = { header: { id: 'bot-session-1', cwd: '/tmp' }, seq: 0 }
  const agent = {
    session,
    status: 'idle',
    whenIdle: () => Promise.resolve(),
    followup: () => { script.followup(harness) },
  }
  const harness: Harness = {
    agent,
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) (listener as (...a: unknown[]) => void)(...args)
    },
    emitTurn(text) {
      session.seq += 1
      harness.emit('session/event', session, { type: 'assistant/message', seq: session.seq, data: { message: { content: [{ type: 'text', text }] } } })
      session.seq += 1
      harness.emit('session/event', session, { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'completed' } } })
    },
  }
  let calls = 0
  let stdout = ''
  const exited = new Promise<number>((resolve) => {
    const services: Record<string, unknown> = {
      appExit: resolve,
      agents: { create: () => Promise.resolve({ agent }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'ahv-router', model: 'ahv-qwen38' }) },
      sessions: { flush: () => Promise.resolve() },
      subagents: script.waitForChildren === undefined
        ? undefined
        : { waitForChildren: () => Promise.resolve(script.waitForChildren!(harness, ++calls)) },
    }
    const ctx = {
      get: (name: string) => services[name],
      on: (name: string, listener: Listener) => {
        listeners.set(name, [...listeners.get(name) ?? [], listener])
        return () => { listeners.set(name, (listeners.get(name) ?? []).filter(entry => entry !== listener)) }
      },
    } as never
    internals.stdout = { write: (chunk: string) => { stdout += chunk; return true } }
    internals.stderr = { write: () => true }
    apply(ctx, Config({ prompt: 'hi', cwd: '/tmp', output: 'jsonl', noColor: true, noBanner: true, systemSuffix: '' }))
  })
  const code = await exited
  return { code, stdout }
}

function finals(stdout: string): string[] {
  return stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; text?: string })
    .filter(event => event.type === 'assistant_final').map(event => event.text ?? '')
}

describe('bot-runner with subagent activations', () => {
  it('waits for the child completion notice turn before exiting', async () => {
    const { code, stdout } = await runBot({
      followup: h => h.emitTurn('Đã giao việc cho subagent.'),
      waitForChildren: (h, call) => {
        if (call > 1) return false
        h.emitTurn('Kết quả từ subagent.')
        return true
      },
    })
    expect(code).toBe(0)
    expect(finals(stdout)).toEqual(['Đã giao việc cho subagent.', 'Kết quả từ subagent.'])
  })

  it('exits after one idle when no child runs', async () => {
    const { code, stdout } = await runBot({ followup: h => h.emitTurn('PONG'), waitForChildren: () => false })
    expect(code).toBe(0)
    expect(finals(stdout)).toEqual(['PONG'])
  })

  it('fails with the live agent error when no turn/end follows it', async () => {
    const { code, stdout } = await runBot({
      followup: h => h.emit('agent/error', { agent: undefined, error: new Error('never matches') }),
    })
    // An error from another Agent does not fail this run.
    expect(code).toBe(1)
    expect(stdout).toContain('không có assistant_final')
    const failed = await runBot({
      followup: (h) => { h.emit('agent/error', { agent: h.agent, error: new Error('provider exploded') }) },
    })
    expect(failed.code).toBe(1)
    expect(failed.stdout).toContain('provider exploded')
  })
})
