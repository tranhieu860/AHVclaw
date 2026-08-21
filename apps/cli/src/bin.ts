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
 * to `ahv` so the router-preconfigured bundle loads without the user
 * having to pass --profile every call. `dsh` invocation still requires an
 * explicit --profile.
 */
function withAhvDefaultProfile(argv: readonly string[]): string[] {
  const invokedAs = basename(process.argv[1] ?? '').toLowerCase()
  const looksLikeAhv = invokedAs === 'ahv' || invokedAs === 'ahv.js' || invokedAs === 'ahv.mjs'
  if (!looksLikeAhv) return [...argv]
  // The bin sees the whole argv (post-slice(2) here), so peek before parseDshArgs.
  const hasProfileFlag = argv.some(a => a === '--profile' || a === '-p' || a.startsWith('--profile='))
  const usesSubcommand = argv.length > 0 && ['web', 'plugin', 'ahv'].includes(argv[0] ?? '')
  if (hasProfileFlag || usesSubcommand) return [...argv]
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
