// AHV fork: sessions written by dsh 0.1.1-rc.1 (the AHV CLI core until 29/09/2026).
import { describe, expect, it } from 'vitest'
import { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import { normalizeAhvFork011Event } from '../src/ahv-fork-legacy.ts'
import { restoreV0ToV1 } from '../src/testing/restore.ts'

// The opening rows exactly as 0.1.1-rc.1 wrote them for a Telegram-bot session.
const header = { type: 'session', version: 0, id: 'tg-1-0-abc', createdAt: 1790633664769, cwd: '/home/ahvproxy/AHV-ahvclaw', delegationDepth: 0 }
const opening = [
  { type: 'permission/preset', seq: 0, time: 1790633664771, data: { preset: 'workspace-write', origin: 'default' } },
  { type: 'sandbox/mode', seq: 1, time: 1790633664773, data: { mode: 'workspace-write' } },
  { type: 'approval/policy', seq: 2, time: 1790633664773, data: { policy: 'ask' } },
]

describe('AHV fork 0.1.1-rc.1 sessions', () => {
  it('migrates a session whose permission/preset carries origin', () => {
    const artifact = restoreV0ToV1(header, opening)
    const preset = artifact.events.find(event => event.type === 'permission/preset')
    expect(preset?.data).toEqual({ preset: 'workspace-write' })
    expect(artifact.events).toHaveLength(opening.length)
  })

  it('keeps every other member, including a preset chosen by the user', () => {
    const artifact = restoreV0ToV1(header, [
      { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'read-only', origin: 'user' } },
    ])
    expect(artifact.events[0]?.data).toEqual({ preset: 'read-only' })
  })

  it('leaves events without the member untouched (same reference)', () => {
    const event = { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write' } }
    expect(normalizeAhvFork011Event(event as never)).toBe(event)
    const other = { type: 'sandbox/mode', seq: 1, time: 1, data: { mode: 'read-only', origin: 'x' } }
    expect(normalizeAhvFork011Event(other as never)).toBe(other)
  })

  it('still refuses members the fork never wrote', () => {
    expect(() => restoreV0ToV1(header, [
      { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write', surprise: true } },
    ])).toThrow(SessionFormatUnsupportedMigrationError)
  })
})
