/**
 * Function plugin registering the `sessionListMetadata` projection unit.
 *
 * The web proxy registers this key too, but the Telegram bot drives the CLI
 * through `ahv run`, which composes no proxy — so its sessions reached the
 * projection cache without the hints the session list reads, and the web
 * listed those conversations untitled with a stale time. Mounting this plugin
 * in a headless bundle closes that gap; when both are composed the registry
 * refcounts the identical registration.
 *
 * @module @deepseek-ai/dsh-session-list-metadata
 */

import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: brings the registry's Context augmentation
// (`ctx.sessionProjections`) into the program without a runtime import.
import type {} from '@deepseek-ai/dsh-session-projection'
import { sessionListMetadataProjectionDefinition } from './projection.ts'

/** Cordis plugin name. */
export const name = 'session-list-metadata'
/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
export const inject = ['sessionProjections']

/**
 * Register the `sessionListMetadata` unit; the registration is an effect on
 * this plugin's fiber, so unloading removes the key.
 * @param ctx - registrant context carrying the projection registry.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(sessionListMetadataProjectionDefinition)
}
