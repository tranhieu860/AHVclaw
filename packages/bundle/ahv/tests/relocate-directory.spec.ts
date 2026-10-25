import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, Config, internals, relocateMissingDirectory } from '../src/bot-runner.ts'

/**
 * dsh 0.2.1 fails every turn of a Session whose working directory no longer
 * exists. A resumed bot turn moves such a Session to the invocation's --cwd.
 */

const dirs: string[] = []
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'ahv-relocate-'))
  dirs.push(path)
  return path
}
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }) })

/** A working-directory service whose Session directory is `current`. */
function service(current: string) {
  const moves: string[] = []
  return {
    moves,
    workingDirectory: {
      get: () => current,
      set: (_agent: unknown, path: string) => { moves.push(path); return Promise.resolve(path) },
    },
  }
}

const agent = { session: { header: { id: 'bot-session-1', cwd: '/tmp' }, seq: 0 } } as never

function contextWith(services: Record<string, unknown>) {
  return { get: (name: string) => services[name] } as never
}

describe('relocateMissingDirectory', () => {
  it('moves a Session whose directory vanished to an existing --cwd', async () => {
    const cwd = directory()
    const fake = service(join(cwd, 'gone'))
    await relocateMissingDirectory(contextWith({ workingDirectory: fake.workingDirectory }), agent, cwd)
    expect(fake.moves).toEqual([cwd])
  })

  it('keeps a Session whose directory still exists', async () => {
    const fake = service(directory())
    await relocateMissingDirectory(contextWith({ workingDirectory: fake.workingDirectory }), agent, directory())
    expect(fake.moves).toEqual([])
  })

  it('leaves the Session alone when --cwd is missing too', async () => {
    const fake = service('/nonexistent/ahv-relocate-a')
    await relocateMissingDirectory(contextWith({ workingDirectory: fake.workingDirectory }), agent, '/nonexistent/ahv-relocate-b')
    expect(fake.moves).toEqual([])
  })
})

describe('bot-runner resume', () => {
  /** Run one turn and return the directory moves the runner committed. */
  async function run(resume: boolean): Promise<string[]> {
    const cwd = directory()
    const fake = service(join(cwd, 'gone'))
    const turnAgent = { ...agent as object, status: 'idle', whenIdle: () => Promise.resolve(), followup: () => {} }
    await new Promise<number>((resolve) => {
      const services: Record<string, unknown> = {
        appExit: resolve,
        agents: { create: () => Promise.resolve({ agent: turnAgent }), resume: () => Promise.resolve({ agent: turnAgent }) },
        agentDefaultModel: { currentSelection: () => ({ provider: 'ahv-router', model: 'ahv-qwen38' }) },
        sessions: { flush: () => Promise.resolve() },
        workingDirectory: fake.workingDirectory,
      }
      const ctx = { get: (name: string) => services[name], on: () => () => {} } as never
      internals.stdout = { write: () => true }
      internals.stderr = { write: () => true }
      apply(ctx, Config({ prompt: 'hi', cwd, ...resume ? { resumeSessionId: 'bot-session-1' } : {}, output: 'jsonl', noColor: true, noBanner: true, systemSuffix: '' }))
    })
    return fake.moves
  }

  it('relocates a resumed Session before the prompt', async () => {
    expect(await run(true)).toHaveLength(1)
  })

  it('does not touch a fresh Session', async () => {
    expect(await run(false)).toEqual([])
  })
})
