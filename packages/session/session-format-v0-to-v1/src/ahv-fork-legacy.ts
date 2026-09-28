/**
 * AHV fork: normalizations for sessions written by the AHV CLI on dsh
 * 0.1.1-rc.1, the prerelease the fork shipped from 21/08 to 29/09/2026.
 *
 * The released-v0 inventory this edge validates was frozen at
 * `dsh-v0.1.2-rc.1`; 0.1.1-rc.1 wrote a few members that tag no longer has,
 * so every Telegram-bot conversation on the fleet was refused on the first
 * resume after the upgrade. Each rule below removes one member whose meaning
 * the later format dropped; nothing model-visible changes.
 *
 * @module @deepseek-ai/dsh-session-format-v0-to-v1/ahv-fork-legacy
 */

import type { SessionFormatEvent, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

type JsonRecord = Record<string, SessionFormatJsonValue>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Drop one data member when present, keeping the event otherwise identical.
 * @param event - source event.
 * @param member - payload member to remove.
 * @returns the same reference when the member is absent.
 */
function withoutDataMember(event: SessionFormatEvent, member: string): SessionFormatEvent {
  if (!isRecord(event.data) || !Object.hasOwn(event.data, member)) return event
  const { [member]: _dropped, ...data } = event.data
  return { ...event, data } as SessionFormatEvent
}

/**
 * Normalize one released-v0 event written by dsh 0.1.1-rc.1.
 * @param event - source event before the upstream legacy normalizers run.
 * @returns the event the frozen v0 inventory accepts.
 */
export function normalizeAhvFork011Event(event: SessionFormatEvent): SessionFormatEvent {
  switch (event.type) {
    // 0.1.1-rc.1 recorded where the preset came from ("default" / "user");
    // 0.1.2-rc.1 no longer carries it and the session keeps the preset itself.
    case 'permission/preset':
      return withoutDataMember(event, 'origin')
    default:
      return event
  }
}
