#!/usr/bin/env node
/**
 * Command-line entry for dsh.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { getDshRuntimeVersion, loadLayeredEnv, StartupError } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { basename } from 'node:path'
import { parseDshArgs } from './args.ts'
import { reportStartupFailure } from './startup-diagnostics.ts'

/**
 * When invoked as `ahv` (AHV Holding rebrand alias), default the profile
 * so the router-preconfigured bundle loads without --profile every call.
 * - `ahv "task"`      → --profile ahv       (headless one-shot, terminal only)
 * - `ahv web`         → --profile ahv-web   (web UI + Plugin Market)
 * - `ahv --profile X` → left as-is
 * - `dsh …`           → left as-is (upstream compat)
 */
function withAhvDefaultProfile(argv: readonly string[]): string[] {
  const invokedAs = basename(process.argv[1] ?? '').toLowerCase()
  const looksLikeAhv = invokedAs === 'ahv' || invokedAs === 'ahv.js' || invokedAs === 'ahv.mjs'
  if (!looksLikeAhv) return [...argv]
  const hasProfileFlag = argv.some(a => a === '--profile' || a === '-p' || a.startsWith('--profile='))
  if (hasProfileFlag) return [...argv]
  // `ahv web [args…]` → `--profile ahv-web [args…]` (drop the `web` alias).
  if (argv[0] === 'web') return ['--profile', 'ahv-web', ...argv.slice(1)]
  // Preserve `plugin` and any other real subcommand as-is.
  const usesSubcommand = argv.length > 0 && ['plugin'].includes(argv[0] ?? '')
  if (usesSubcommand) return [...argv]
  return ['--profile', 'ahv', ...argv]
}

/**
 * Run the public dsh command-line interface.
 * @returns a promise that settles when the selected command mode finishes.
 */
export async function runCli(): Promise<void> {
  const version = getDshRuntimeVersion()
  const invocation = parseDshArgs(withAhvDefaultProfile(process.argv.slice(2)), version)

  switch (invocation.mode) {
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      try {
        await runProfile({
          environment: loadLayeredEnv('dsh'),
          profile: invocation.profile,
          fromDefaultProfile: invocation.fromDefaultProfile,
          patchFiles: invocation.patches,
          args: invocation.args,
        })
      } catch (error) {
        if (!(error instanceof StartupError)) throw error
        await reportStartupFailure(error, { home: resolveDshHome(), version, profile: invocation.profile })
        process.exit(1)
      }
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(await runPlugin(invocation.profile, invocation.args))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    case 'dump-config-schema': {
      const { runDumpConfigSchema } = await import('./dump-config-schema.ts')
      await runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

if (import.meta.main) {
  await runCli()
}
