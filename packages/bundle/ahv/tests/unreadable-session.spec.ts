import { describe, expect, it } from 'vitest'
import { resumeOrReportUnreadable } from '../src/bot-runner.ts'

// The Telegram bot (ahv-bot/bot.py is_missing_session_error) starts a fresh
// session when an internal_error message says "session … not found".
const botRecovers = (message: string) => message.toLowerCase().includes('session') && message.toLowerCase().includes('not found')

describe('resumeOrReportUnreadable', () => {
  it('turns a migration refusal into the error the bot recovers from', async () => {
    const refusal = new Error('@deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session: permission/preset 0 data has unexpected member "x"')
    const error = await resumeOrReportUnreadable(() => Promise.reject(refusal), 'tg-1-0-abc').catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect(botRecovers((error as Error).message)).toBe(true)
    expect((error as Error).message).toContain('tg-1-0-abc')
    expect((error as Error).cause).toBe(refusal)
  })

  it('covers the other refusals the migration raises', async () => {
    for (const text of ['subagent/descriptor 0 uses unsupported descriptor version 2',
      'format v0 contains unknown historical event type "x" at seq 3; migration refuses unknown historical events even when ignorable']) {
      const error = await resumeOrReportUnreadable(() => Promise.reject(new Error(text)), 's').catch((e: Error) => e)
      expect(botRecovers((error as Error).message)).toBe(true)
    }
  })

  it('leaves every other failure as it was', async () => {
    const other = new Error('ECONNREFUSED 127.0.0.1')
    await expect(resumeOrReportUnreadable(() => Promise.reject(other), 's')).rejects.toBe(other)
  })

  it('passes a successful resume through', async () => {
    await expect(resumeOrReportUnreadable(() => Promise.resolve(42), 's')).resolves.toBe(42)
  })
})
