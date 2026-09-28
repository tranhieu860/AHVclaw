/**
 * The `sessionListMetadata` projection unit: the two hints the session list
 * needs to summarise a cold session without reading its log — whether the
 * checkpoint prefix contains no turn, and when the latest human prompt landed.
 *
 * The fold is a copy of the one in `dsh-api-session-controller` (`src/list.ts`) (same key, same
 * `stateVersion`), deliberately duplicated rather than imported: this package
 * exists so a headless `ahv run` can produce the unit without pulling in the
 * whole web session controller, and the projection registry refcounts identical
 * registrations, so both may be composed at once.
 *
 * @module @deepseek-ai/dsh-session-list-metadata/projection
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/**
 * Persisted hints used to summarise a cold session. Mirrors
 * `SessionListMetadata` in `dsh-api-session-controller/src/types.ts`; that
 * package is a client+host package outside the host project graph, so the
 * shape is restated here instead of imported.
 */
export interface SessionListMetadata {
  /** Whether the folded prefix contains no turn. */
  readonly blank: boolean
  /** Latest human-authored prompt time in the folded prefix. */
  readonly lastPromptAt: number | null
}

// Same key and value shape the session controller declares, so the two
// augmentations merge when both packages share one program.
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    sessionListMetadata: SessionListMetadata
  }
  interface SessionProjectionMap {
    sessionListMetadata: SessionListMetadata
  }
}

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
