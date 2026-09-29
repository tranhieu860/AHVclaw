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
// Usage: node ahv-plugin-grants.mjs [--print-default-model] <fork> <dsh-home> <profile>...
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

/** The AHV default when the user never chose one. */
export const AHV_DEFAULT_MODEL = Object.freeze({ provider: 'ahv-router', model: 'ahv-qwen38', reasoningEffort: '' })
const SAFE_VALUE = /^[A-Za-z0-9._:/@+-]{1,128}$/

function unquote(value) {
  const v = value.trim().replace(/\s+#.*$/, '')
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1)
  return v
}

function pickSelection(fields) {
  const provider = unquote(fields.provider ?? '')
  const model = unquote(fields.model ?? '')
  const effort = unquote(fields.reasoningEffort ?? '')
  if (!SAFE_VALUE.test(provider) || !SAFE_VALUE.test(model)) return undefined
  return { provider, model, reasoningEffort: SAFE_VALUE.test(effort) ? effort : '' }
}

/**
 * The `agent-default-model` row a profile patch holds (what 0.2's web settings
 * write when the user picks a default model), or undefined.
 * @param text - contents of <profile>/cordis.patch.yml.
 */
export function defaultModelFromPatch(text) {
  const lines = String(text ?? '').split('\n')
  const start = lines.findIndex(line => /^- id:\s*['"]?agent-default-model['"]?\s*$/.test(line))
  if (start < 0) return undefined
  const fields = {}
  let inConfig = false
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break // next top-level row
    if (/^ {2}config:\s*$/.test(line)) { inConfig = true; continue }
    if (/^ {2}\S/.test(line)) { inConfig = false; continue }
    const m = inConfig && /^ {4}(provider|model|reasoningEffort):\s*(.+)$/.exec(line)
    if (m) fields[m[1]] = m[2]
  }
  return pickSelection(fields)
}

/**
 * The `agent-default-model` section of the 0.1-era $DSH_HOME/settings.yaml.
 * dsh 0.2 renames the file to settings.yaml.imported and does not carry this
 * section into the profile, so the choice survives only there.
 * @param text - contents of settings.yaml(.imported).
 */
export function defaultModelFromLegacySettings(text) {
  const lines = String(text ?? '').split('\n')
  const start = lines.findIndex(line => /^agent-default-model:\s*$/.test(line))
  if (start < 0) return undefined
  const fields = {}
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const m = /^ {2}(provider|model|reasoningEffort):\s*(.+)$/.exec(line)
    if (m) fields[m[1]] = m[2]
  }
  return pickSelection(fields)
}

function readText(path) {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

/**
 * The default model the user chose, as the 0.1 CLI honoured it for every
 * profile: the web's own setting first, then the headless profile, then the
 * 0.1 settings.yaml (live or already renamed by 0.2), then the AHV default.
 * The AHV bundle patch reads the result from AHV_DEFAULT_* at load time.
 * @param dshHome - the dsh home.
 */
export function chosenDefaultModel(dshHome) {
  const profiles = join(dshHome, 'profiles')
  return defaultModelFromPatch(readText(join(profiles, 'web', 'cordis.patch.yml')))
    ?? defaultModelFromPatch(readText(join(profiles, 'headless', 'cordis.patch.yml')))
    ?? defaultModelFromLegacySettings(readText(join(dshHome, 'settings.yaml')))
    ?? defaultModelFromLegacySettings(readText(join(dshHome, 'settings.yaml.imported')))
    ?? AHV_DEFAULT_MODEL
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
  const args = process.argv.slice(2)
  const printDefault = args[0] === '--print-default-model'
  const [fork, dshHome, ...profiles] = printDefault ? args.slice(1) : args
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
  if (printDefault) {
    // Three lines (provider, model, reasoning effort or empty) for the wrapper
    // to `read`; values are already restricted to a safe character set.
    const choice = chosenDefaultModel(dshHome)
    process.stdout.write(`${choice.provider}\n${choice.model}\n${choice.reasoningEffort}\n`)
  }
}
