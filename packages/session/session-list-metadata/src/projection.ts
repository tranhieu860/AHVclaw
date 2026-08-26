/**
 * The `sessionListMetadata` projection unit: the two hints the session list
 * needs to summarise a cold session without reading its log — whether the
 * checkpoint prefix contains no turn, and when the latest human prompt landed.
 *
 * The fold is a copy of the one in `dsh-host-apiproxy` (same key, same
 * `stateVersion`), deliberately duplicated rather than imported: this package
 * exists so a headless `ahv run` can produce the unit without pulling in the
 * whole web proxy, and the projection registry refcounts identical
 * registrations, so both may be composed at once.
 *
 * @module @deepseek-ai/dsh-session-list-metadata/projection
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
// Type-only: keeps the key's `SessionProjectionStateMap` augmentation (declared
// by the proxy) in the type graph without a runtime dependency on it.
import type { SessionListMetadata } from '@deepseek-ai/dsh-host-apiproxy/api/sessions'

const schema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

/**
 * Advance the hint state by one committed event.
 * @param state - the state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state, or the same reference when nothing changed.
 */
function apply(state: SessionListMetadata, event: SessionEvent): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/** The unit as the registry consumes it. */
export const sessionListMetadataProjectionDefinition = {
  key: 'sessionListMetadata',
  stateVersion: 1,
  stateSchema: schema,
  init: (): SessionListMetadata => ({ blank: true, lastPromptAt: null }),
  apply,
  wire: { viewSchema: schema, view: (state: SessionListMetadata) => state },
} as const
