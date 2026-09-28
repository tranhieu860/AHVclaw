#!/usr/bin/env node
// Grant the dsh version exemptions for the plugins this AHV release ships.
//
// dsh 0.2 refuses to mount a plugin whose `peerDependencies` on
// `@deepseek-ai/dsh-*` do not include the running version, unless the profile's
// `compatibility.json` names that exact package@version for that exact dsh
// version. The AHV bundle pins third-party plugins (subscriptions, browser, …)
// that still declare 0.1.x peers; without a grant every run silently loses the
// Claude/Codex/Grok subscriptions and the browser tools.
//
// A release only reaches a machine after its smoke ran these exact versions on
// this exact dsh, so the release vouches for them: the grant names the versions
// installed in this tree and the dsh version of this tree, nothing broader. A
// user-installed plugin is never granted here, and existing grants are kept.
//
// Usage: node ahv-plugin-grants.mjs <fork> <dsh-home> <profile>...
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugins AHV installs into a profile itself (scripts/install-ahv-skin.sh). */
const AHV_PROFILE_PLUGINS = ['@linxin666/dsh-client-ui-skin-center']

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function installedVersion(dir) {
  const manifest = readJson(join(dir, 'package.json'))
  return typeof manifest?.name === 'string' && typeof manifest?.version === 'string'
    ? `${manifest.name}@${manifest.version}`
    : undefined
}

/**
 * The exact package@version keys this install vouches for in one profile.
 * @param fork - the install's source tree.
 * @param profileDir - the profile directory.
 * @returns sorted, de-duplicated package@version keys.
 */
export function shippedPluginKeys(fork, profileDir) {
  const bundleDir = join(fork, 'packages', 'bundle', 'ahv')
  const bundle = readJson(join(bundleDir, 'package.json')) ?? {}
  const keys = new Set()
  for (const [name, spec] of Object.entries(bundle.dependencies ?? {})) {
    if (typeof spec !== 'string' || spec.startsWith('workspace:')) continue
    const key = installedVersion(join(bundleDir, 'node_modules', name))
    if (key !== undefined) keys.add(key)
  }
  for (const name of AHV_PROFILE_PLUGINS) {
    const key = installedVersion(join(profileDir, 'node_modules', name))
    if (key !== undefined) keys.add(key)
  }
  return [...keys].sort()
}

/**
 * Merge this install's grants into a profile's compatibility file.
 * @param fork - the install's source tree.
 * @param dshHome - the dsh home holding the profiles.
 * @param profile - profile name.
 * @returns what happened: 'written', 'unchanged', or 'skipped' with a reason.
 */
export function grantShippedPlugins(fork, dshHome, profile) {
  const runtime = readJson(join(fork, 'apps', 'cli', 'package.json'))?.version
  if (typeof runtime !== 'string') return { status: 'skipped', reason: 'dsh version unreadable' }
  const profileDir = join(dshHome, 'profiles', profile)
  const file = join(profileDir, 'compatibility.json')
  let current = {}
  if (existsSync(file)) {
    const parsed = readJson(file)
    // dsh ignores a file it cannot read; overwriting it would destroy
    // whatever the user was trying to express, so leave it for them.
    if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'skipped', reason: `${file} is not a JSON object` }
    }
    current = parsed
  }
  const next = { ...current }
  let changed = false
  for (const key of shippedPluginKeys(fork, profileDir)) {
    const versions = Array.isArray(next[key]) ? [...next[key]] : []
    if (versions.includes(runtime)) continue
    versions.push(runtime)
    next[key] = versions
    changed = true
  }
  if (!changed) return { status: 'unchanged' }
  // dsh creates the rest of the profile on first use and only keys that on
  // package.json, so a directory holding just this file is still initialised.
  mkdirSync(profileDir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o644 })
  renameSync(tmp, file)
  return { status: 'written' }
}

/** Whether this file is the entry script; ~/.ahv/src is a symlink, so compare real paths. */
function isEntryScript() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryScript()) {
  const [fork, dshHome, ...profiles] = process.argv.slice(2)
  if (!fork || !dshHome || profiles.length === 0) {
    process.stderr.write('usage: ahv-plugin-grants.mjs <fork> <dsh-home> <profile>...\n')
    process.exit(2)
  }
  for (const profile of profiles) {
    try {
      const result = grantShippedPlugins(fork, dshHome, profile)
      if (result.status === 'skipped') process.stderr.write(`ahv: plugin grants for ${profile} skipped: ${result.reason}\n`)
    } catch (error) {
      // A grant problem must never stop the CLI; dsh then reports the plugin itself.
      process.stderr.write(`ahv: plugin grants for ${profile} failed: ${error.message}\n`)
    }
  }
}
