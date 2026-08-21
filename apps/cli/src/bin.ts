#!/usr/bin/env node
/**
 * dsh — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { parseDshArgs } from './args.ts'

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

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

const invocation = parseDshArgs(withAhvDefaultProfile(process.argv.slice(2)), readVersion())

switch (invocation.mode) {
  case 'profile': {
    const { runProfile } = await import('./profile-boot.ts')
    await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: invocation.profile,
      patchFiles: invocation.patches,
      args: invocation.args,
    })
    break
  }
  case 'plugin': {
    const { runPlugin } = await import('./plugin.ts')
    process.exit(runPlugin(invocation.profile, invocation.args))
    break
  }
  case 'dump-config': {
    const { runDumpConfig } = await import('./dump-config.ts')
    runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
    break
  }
  default:
    invocation satisfies never
    throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
}
