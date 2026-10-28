import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, Config, internals, missingSessionDirectory } from '../src/bot-runner.ts'

/**
 * dsh 0.2.1 confines every tool to the Session header `cwd`. A resumed Session
 * whose header directory vanished cannot run a command anywhere, so the runner
 * reports the bot's "session not found" error and the bot opens a fresh Session.
 */

const dirs: string[] = []
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'ahv-session-dir-'))
  dirs.push(path)
  return path
}
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }) })

function session(cwd: string | undefined) {
  return { header: { id: 'bot-session-1', ...cwd === undefined ? {} : { cwd } }, seq: 0 } as never
}

/** `is_missing_session_error` of ahv-bot/bot.py (gói bot v0.0.452). */
function botSeesMissingSession(code: string, message: string): boolean {
  const text = message.toLowerCase()
  return code === 'internal_error' && text.includes('session') && text.includes('not found')
}

describe('missingSessionDirectory', () => {
  it('returns a header directory that no longer exists', () => {
    const gone = join(directory(), 'gone')
    expect(missingSessionDirectory(session(gone))).toBe(gone)
  })

  it('accepts an existing header directory and a Session without one', () => {
    expect(missingSessionDirectory(session(directory()))).toBeUndefined()
    expect(missingSessionDirectory(session(undefined))).toBeUndefined()
  })
})

describe('bot-runner resume', () => {
  /** Run one invocation over a Session rooted at `root`; return its exit code, rows, and whether a prompt was sent. */
  async function run(root: string, resume: boolean) {
    const turnSession = session(root)
    let prompted = false
    let stdout = ''
    const turnAgent = { session: turnSession, status: 'idle', whenIdle: () => Promise.resolve(), followup: () => { prompted = true } }
    const code = await new Promise<number>((resolve) => {
      const services: Record<string, unknown> = {
        appExit: resolve,
        agents: { create: () => Promise.resolve({ agent: turnAgent }), resume: () => Promise.resolve({ agent: turnAgent }) },
        agentDefaultModel: { currentSelection: () => ({ provider: 'ahv-router', model: 'AHV-Holding' }) },
        sessions: { flush: () => Promise.resolve() },
      }
      const ctx = { get: (name: string) => services[name], on: () => () => {} } as never
      internals.stdout = { write: (chunk: string) => { stdout += chunk; return true } }
      internals.stderr = { write: () => true }
      apply(ctx, Config({ prompt: 'hi', cwd: directory(), ...resume ? { resumeSessionId: 'bot-session-1' } : {}, output: 'jsonl', noColor: true, noBanner: true, systemSuffix: '' }))
    })
    const rows = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    return { code, rows, prompted }
  }

  it('fails a resumed Session whose header directory vanished with the bot missing-session error', async () => {
    const gone = join(directory(), 'gone')
    const { code, rows, prompted } = await run(gone, true)
    expect(prompted).toBe(false)
    expect(code).toBe(1)
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row).toMatchObject({ type: 'error', code: 'internal_error', terminal: true, reason: 'session_dir_missing' })
    expect(row!.message).toContain(gone)
    expect(botSeesMissingSession(row!.code as string, row!.message as string)).toBe(true)
  })

  it('runs a resumed Session whose header directory exists', async () => {
    const { prompted } = await run(directory(), true)
    expect(prompted).toBe(true)
  })

  it('does not check a fresh Session', async () => {
    const { prompted } = await run(join(directory(), 'gone'), false)
    expect(prompted).toBe(true)
  })
})
