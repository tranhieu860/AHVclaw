import { defineConfig } from 'tsdown'

/**
 * The ahv bundle ships 4 entries: the placeholder module + invariant + the
 * two bot-adapter plugins (bot-runner + bot-startup). Root tsdown's default
 * globs only pick {index, invariant, startup}, so we override entry here to
 * include the bot-runner pair.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/bot-runner.js', 'lib/types/bot-startup.js', 'lib/types/bot-list-models.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
