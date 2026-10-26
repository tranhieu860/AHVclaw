import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath } from '../src/format.ts'

const id = SessionId('successor-admission')
const header = { type: 'session', version: SESSION_FORMAT_VERSION, id, createdAt: 1000, isSeeded: false, delegationDepth: 0 }
const toolCall = { callId: 'toolu_1', rootCallId: 'toolu_1' }
const registered = { jobId: 'bash-f7e3d2da79e34c74', owner: id, kind: 'bash', label: 'cat secret.txt', startedAt: 10, toolCall }

/** Rows copied from a Session written by the dsh 0.2.1-rc.3 harness (bash job, then a `cd`). */
const successorRows = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'job/registered', seq: 1, time: 10, data: registered },
  {
    type: 'job/settled', seq: 2, time: 11,
    data: { ...registered, finishedAt: 11, status: 'completed', cause: 'producer', producerReported: true, detail: 'exit code: 0' },
  },
  { type: 'working-directory/change', seq: 3, time: 12, data: { cwd: '/work/sub' } },
  {
    type: 'user/message', seq: 4, time: 13, surfaceOp: 'append',
    data: {
      id: 'notice-1', role: 'user', source: { kind: 'working-directory' },
      content: [{ type: 'text', text: 'The working directory changed from "/work" to "/work/sub".' }],
    },
  },
]

describe('dsh 0.2.1 successor event admission', () => {
  let root: string
  let ctx: Context

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-successor-admission-'))
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })

  afterEach(async () => {
    try {
      await ctx?.fiber.dispose()
    } finally {
      if (root !== undefined) await rm(root, { recursive: true, force: true })
    }
  })

  it('reads job and working-directory records and appends after them without rewriting them', async () => {
    const bytes = Buffer.from([header, ...successorRows].map(row => JSON.stringify(row)).join('\n') + '\n')
    const path = generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)

    const writer = await ctx.sessionPersistence.open(id, 'write')
    try {
      expect((await writer.read()).events).toEqual(successorRows)
      await writer.append([{
        type: 'turn/end', seq: SessionSeq(5), time: 14, data: { turn: 1, reason: { kind: 'completed' } },
      }])
    } finally {
      await writer.close()
    }
    expect((await readFile(path)).subarray(0, bytes.length)).toEqual(bytes)
  })
})
