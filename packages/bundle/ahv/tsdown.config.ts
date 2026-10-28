import { defineConfig } from 'tsdown'

/**
 * The ahv bundle ships 5 entries: the placeholder module, the bot-adapter
 * plugins (bot-runner + bot-startup + bot-list-models) and retired-models.
 * Root tsdown's default globs only pick {index, startup}, so we override entry
 * here to include the plugins.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/bot-runner.js', 'lib/types/bot-startup.js', 'lib/types/bot-list-models.js', 'lib/types/retired-models.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
