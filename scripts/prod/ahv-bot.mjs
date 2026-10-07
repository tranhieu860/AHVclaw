#!/usr/bin/env node
// ahv-bot.mjs — Node CLI adapter cho các subcommand bot team yêu cầu:
//   auth status/login/logout --json
//   doctor --json
//   sessions list/show/latest --json
//   run  → forwards to `dsh --profile bot -- --prompt-file …`
//   version
//
// Ngoài `run` (spawn dsh), tất cả subcommand còn lại chỉ đọc filesystem/env
// và probe HTTP — không gọi model, không log secret.
//
// Exit codes tuân bot spec:
//   0 = ok / completed
//   1 = terminal (missing_credential, not_logged_in, quota, permission)
//   2 = recoverable (rate_limit, network_transient, model_unavailable)
//   124 = timeout / cancelled

import { spawn, execFileSync } from 'node:child_process'
import { renameSync, readFileSync, existsSync, statSync, readdirSync, writeFileSync, chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { resolve as resolvePath, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const FORK = process.env.AHV_FORK ?? resolvePath(HERE, '..', 'src')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const AHV_ENV_FILE = join(homedir(), '.ahv', 'env')
const DEFAULT_MODEL = process.env.AHV_MODEL ?? 'ahv-qwen38'
const DEFAULT_BASE_URL = 'http://15.235.200.66:2022/v1'

function loadEnvFile(path) {
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/i.exec(line)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}
loadEnvFile(AHV_ENV_FILE)

function printJson(obj, exitCode = 0) {
  // stdout.write async khi output > 64KB pipe buffer + process.exit()
  // interrupt → truncate. Callback + brief tick đảm bảo flushed trước exit.
  const payload = JSON.stringify(obj) + '\n'
  process.stdout.write(payload, () => process.exit(exitCode))
}

function errJson(code, message, terminal = true, retryAfterSec = 0, exitCode = 1) {
  process.stdout.write(JSON.stringify({
    type: 'error',
    code,
    terminal,
    retry_after_sec: retryAfterSec,
    message,
  }) + '\n')
  process.exit(exitCode)
}

// ── auth ────────────────────────────────────────────────────────────────
async function authStatus() {
  // Contract: chỉ kiểm credential presence, KHÔNG probe route, KHÔNG in
  // token/key/bearer/cookie. Route-health đã có `ahv doctor`. Exit 0 luôn
  // khi command chạy được (bot đọc field `logged_in` để phân loại).
  const key = process.env.AHV_API_KEY
  if (!key) {
    return printJson({
      logged_in: false,
      credential_source: null,
      provider: 'ahv-router',
      model: DEFAULT_MODEL,
      base_url: DEFAULT_BASE_URL,
      expires_at: null,
      reason: 'AHV_API_KEY chưa được set trong env hoặc ~/.ahv/env',
    }, 0)
  }
  const source = process.env.AHV_API_KEY_SOURCE
    ?? (existsSync(AHV_ENV_FILE) ? 'file' : 'env')
  return printJson({
    logged_in: true,
    credential_source: source,
    provider: 'ahv-router',
    model: DEFAULT_MODEL,
    base_url: DEFAULT_BASE_URL,
    expires_at: null,
  }, 0)
}

function authLogin() {
  errJson(
    'internal_error',
    'AHV router dùng static AHV_API_KEY (env / ~/.ahv/env). ' +
      'Không có OAuth device flow. Set: echo "export AHV_API_KEY=sk-..." >> ~/.ahv/env',
    true, 0, 1,
  )
}

function authLogout() {
  // No persistent credentials — no-op success
  printJson({ logged_out: true, note: 'AHV router không có persistent credential; env sẽ hết khi user unset.' })
}

// ── doctor ──────────────────────────────────────────────────────────────
/**
 * Check that the plugin code a run will load belongs to this install.
 *
 * Every run resolves `@ahvclaw/dsh-bundle-ahv` through the profile's module
 * farm. When that link pointed into another user's home, installing a newer CLI
 * changed nothing at all: the harness kept loading the other tree's plugins, and
 * the only symptom was that a fix "did not work".
 *
 * @param fork - the install's source tree.
 * @param dshHome - the dsh home whose profile farm is inspected.
 * @returns a doctor check describing what the farm resolves to.
 */
export function checkProfileBundleLink(fork, dshHome) {
  const farm = join(dshHome, 'profiles', 'node_modules')
  const link = join(farm, '@ahvclaw', 'dsh-bundle-ahv')
  const expected = join(fork, 'packages', 'bundle', 'ahv')
  const check = { name: 'profile_bundle', value: link }
  if (!existsSync(farm)) {
    // dsh builds the farm on first run; a fresh install simply has none yet.
    check.ok = true
    check.severity = 'ok'
    check.value = 'not built yet'
    return check
  }
  if (!existsSync(link)) {
    check.ok = false
    check.severity = 'warn'
    check.note = 'profile chưa link bundle — wrapper sẽ tự link ở lần chạy tới'
    return check
  }
  let actual = link
  let want = expected
  try {
    actual = realpathSync(link)
    want = realpathSync(expected)
  } catch {
    // Fall through with the unresolved paths; the comparison below still holds.
  }
  check.value = actual
  if (actual !== want) {
    check.ok = false
    check.severity = 'error'
    check.note = `profile dang nap plugin tu ${actual}, khong phai ban da install tai ${want} — moi update se khong co tac dung`
    return check
  }
  check.ok = true
  check.severity = 'ok'
  return check
}

/**
 * Check that dsh can resolve the AHV bundle from its own installation.
 *
 * Since dsh 0.2 a profile resolves plugins through the installation's
 * dependency closure first (apps/cli), so the bundle and every plugin it pins
 * must be reachable from there. Without it the bot runner never mounts and a
 * run has nothing to drive it.
 *
 * @param fork - the install's source tree.
 * @returns a doctor check.
 */
export function checkInstallBundleLink(fork) {
  const link = join(fork, 'apps', 'cli', 'node_modules', '@ahvclaw', 'dsh-bundle-ahv')
  const check = { name: 'install_bundle', value: link }
  let actual
  let want
  try {
    actual = realpathSync(link)
    want = realpathSync(join(fork, 'packages', 'bundle', 'ahv'))
  } catch {
    check.ok = false
    check.severity = 'error'
    check.note = 'apps/cli không phụ thuộc @ahvclaw/dsh-bundle-ahv — bot runner sẽ không nạp được'
    return check
  }
  check.value = actual
  check.ok = actual === want
  check.severity = check.ok ? 'ok' : 'error'
  if (!check.ok) check.note = `bundle trỏ tới ${actual}, không phải ${want}`
  return check
}

async function doctor() {
  // Severity contract cho bot: 'ok' | 'warn' | 'error'.
  // - error = blocking (node/fork/cli_bin/credential thiếu → ahv run không
  //   chạy được. `ok` field aggregate = false, bot phải block user request).
  // - warn = degraded, non-blocking (route probe timeout/HTTP 4xx nhưng
  //   POST /v1/chat/completions vẫn work — router có thể gate /v1/models
  //   khác auth level. `ok` = true, bot vẫn cho run, log warning).
  // - ok = healthy.
  const checks = []
  const nodeVersion = process.versions.node
  const nodeMajor = Number(nodeVersion.split('.')[0])
  checks.push({
    name: 'node', severity: nodeMajor >= 22 ? 'ok' : 'error',
    ok: nodeMajor >= 22, value: `v${nodeVersion}`, required: '>=22',
  })

  try {
    const pnpmVer = (await execCapture('pnpm', ['-v'])).stdout.trim()
    const pnpmMajor = Number(pnpmVer.split('.')[0])
    checks.push({
      name: 'pnpm', severity: pnpmMajor >= 10 ? 'ok' : 'error',
      ok: pnpmMajor >= 10, value: pnpmVer, required: '>=10',
    })
  } catch (e) {
    checks.push({ name: 'pnpm', severity: 'error', ok: false, value: null, error: 'not found' })
  }

  const forkOk = existsSync(FORK)
  checks.push({ name: 'fork', severity: forkOk ? 'ok' : 'error', ok: forkOk, value: FORK })
  const cliBin = join(FORK, 'apps/cli/lib/bin.js')
  const cliBinOk = existsSync(cliBin)
  checks.push({ name: 'cli_bin', severity: cliBinOk ? 'ok' : 'error', ok: cliBinOk, value: cliBin })
  const bundle = join(FORK, 'packages/bundle/ahv/lib/bot-runner.js')
  const bundleOk = existsSync(bundle)
  checks.push({ name: 'ahv_bundle', severity: bundleOk ? 'ok' : 'error', ok: bundleOk, value: bundle })
  const bp = join(DSH_HOME, 'profiles/bot/cordis.patch.yml')
  // bot_profile là legacy — profile-based bot mode không còn dùng
  // (wrapper spawn dsh headless + patch chain), nên downgrade thành warn.
  const bpOk = existsSync(bp)
  checks.push({ name: 'bot_profile', severity: bpOk ? 'ok' : 'warn', ok: bpOk, value: bp, note: 'optional — chỉ dùng nếu chạy `dsh --profile bot` trực tiếp' })

  const keyOk = Boolean(process.env.AHV_API_KEY)
  checks.push({
    name: 'credential', severity: keyOk ? 'ok' : 'error',
    ok: keyOk, value: keyOk ? 'set' : null, required: 'AHV_API_KEY env',
  })

  const sessionsDir = { name: 'sessions_dir', value: SESSIONS_ROOT }
  try {
    if (!existsSync(SESSIONS_ROOT)) {
      // Sessions dir chưa tạo là bình thường trước run đầu tiên → warn.
      sessionsDir.ok = true; sessionsDir.severity = 'warn'; sessionsDir.note = 'chưa tạo (sẽ tự tạo sau run đầu)'
    } else if (!statSync(SESSIONS_ROOT).isDirectory()) {
      sessionsDir.ok = false; sessionsDir.severity = 'error'; sessionsDir.error = 'not a directory'
    } else {
      sessionsDir.ok = true; sessionsDir.severity = 'ok'
    }
  } catch (e) {
    sessionsDir.ok = false; sessionsDir.severity = 'error'; sessionsDir.error = e.message
  }
  checks.push(sessionsDir)

  // model_route: GET /v1/models chỉ là advisory probe. Router có thể trả
  // 401/404/timeout cho /models nhưng vẫn accept POST /chat/completions.
  // Nên downgrade thành warn, không phải error. Bot dùng field `ok=false,
  // severity=warn` để log cảnh báo, không block run.
  const modelCheck = { name: 'model_route', value: DEFAULT_BASE_URL }
  if (keyOk) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(`${DEFAULT_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${process.env.AHV_API_KEY}` },
        signal: controller.signal,
      })
      clearTimeout(timer)
      modelCheck.ok = res.ok
      modelCheck.value = `HTTP ${res.status}`
      modelCheck.severity = res.ok ? 'ok' : 'warn'
      if (!res.ok) modelCheck.note = 'router /v1/models không accessible, nhưng POST /chat/completions có thể vẫn work — advisory'
    } catch (e) {
      modelCheck.ok = false
      modelCheck.severity = 'warn'
      modelCheck.error = e.name === 'AbortError' ? 'timeout' : e.message
      modelCheck.note = 'probe fail — advisory, không blocking run'
    }
  } else {
    modelCheck.ok = false
    modelCheck.severity = 'warn'
    modelCheck.error = 'skipped (no AHV_API_KEY)'
  }
  checks.push(modelCheck)

  // dsh 0.2 never reads the profile farm (checkProfileBundleLink); what a run
  // loads is decided by the installation's dependency closure.
  checks.push(checkInstallBundleLink(FORK))

  // Aggregate ok = TRUE trừ khi có ít nhất 1 check severity='error'.
  // Warn không làm ok=false. Bot dùng ok để phân loại "CLI ready" vs
  // "CLI broken need user action". Duyệt qua severity='error' để list
  // ra lỗi blocking đầu tiên (bot có thể surface cho user).
  const errors = checks.filter(c => c.severity === 'error')
  const warnings = checks.filter(c => c.severity === 'warn')
  printJson({
    ok: errors.length === 0,
    error_count: errors.length,
    warning_count: warnings.length,
    blocking_errors: errors.map(c => ({ name: c.name, reason: c.error ?? c.note ?? 'not ok' })),
    checks,
    ahv_home: dirname(AHV_ENV_FILE),
    dsh_home: DSH_HOME,
    fork: FORK,
  }, 0)
}

function execCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout.on('data', b => stdout += b.toString('utf8'))
    proc.stderr.on('data', b => stderr += b.toString('utf8'))
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }))
  })
}

// ── sessions ────────────────────────────────────────────────────────────
// dsh-session-persistence-jsonl ghi mỗi batch append là 1 zstd frame độc
// lập, các frame concat vào 1 file. `zstdDecompressSync` chỉ decode frame
// đầu (header), nên bot phải iterate qua từng frame theo zstd magic
// 0x28B52FFD để có toàn bộ events. Xem
// packages/session/session-persistence-jsonl/README.md "Physical encoding".
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

function decodeZstdMultiFrame(buf) {
  const chunks = []
  let off = 0
  while (off < buf.length) {
    if (!buf.subarray(off, off + 4).equals(ZSTD_MAGIC)) break
    const remaining = buf.subarray(off)
    chunks.push(zstdDecompressSync(remaining))
    const nextMagic = remaining.indexOf(ZSTD_MAGIC, 4)
    if (nextMagic < 0) break
    off += nextMagic
  }
  return Buffer.concat(chunks)
}

function decodeSessionJsonl(filePath) {
  const buf = readFileSync(filePath)
  const raw = filePath.endsWith('.zstd') ? decodeZstdMultiFrame(buf) : buf
  const lines = raw.toString('utf8').split('\n').filter(Boolean)
  return lines.map(l => JSON.parse(l))
}

/** Session log files in one directory with their format generation and mtime. */
function sessionLogGenerations(sessionPath) {
  const out = []
  for (const name of readdirSync(sessionPath)) {
    const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name)
    if (!match) continue
    const path = join(sessionPath, name)
    let mtime = 0
    try { mtime = statSync(path).mtimeMs } catch { continue }
    out.push({ path, name, version: match[1] === undefined ? 0 : Number(match[1]), compressed: match[2] !== undefined, mtime })
  }
  return out
}

/**
 * The log a session's live conversation is in.
 *
 * dsh 0.2 migrates the version-0 `session.jsonl.zstd` into `session.v<N>.jsonl.zstd`
 * on first open and leaves the source in place, which is what lets a rollback
 * to the 0.1 CLI keep reading it. Normally the newest generation is live. After
 * a rollback the old CLI appends to the version-0 file again, so the file written
 * last is live: that is the rule here, and the rule supersedeStaleGenerations()
 * enforces before a resume.
 *
 * @param sessionPath - one session directory.
 * @returns the log path, or null when the directory holds none.
 */
export function currentSessionLog(sessionPath) {
  let best = null
  for (const gen of sessionLogGenerations(sessionPath)) {
    if (best === null
      || gen.mtime > best.mtime
      || (gen.mtime === best.mtime && (gen.version > best.version || (gen.version === best.version && gen.compressed)))) {
      best = gen
    }
  }
  return best === null ? null : best.path
}

/**
 * Before a resume: when the version-0 log was written after the newest
 * migrated generation (a rollback to the 0.1 CLI ran in between), move the
 * migrated generations aside so dsh 0.2 migrates again from the complete log.
 * Otherwise 0.2 would resume its own older copy and silently drop every turn
 * made during the rollback. Files are renamed, never deleted.
 *
 * @param sessionPath - one session directory.
 * @param now - timestamp for the suffix.
 * @returns the paths that were moved aside.
 */
export function supersedeStaleGenerations(sessionPath, now = Date.now()) {
  const gens = sessionLogGenerations(sessionPath)
  const legacy = gens.filter(g => g.version === 0)
  const migrated = gens.filter(g => g.version > 0)
  if (legacy.length === 0 || migrated.length === 0) return []
  const legacyAt = Math.max(...legacy.map(g => g.mtime))
  const migratedAt = Math.max(...migrated.map(g => g.mtime))
  if (legacyAt <= migratedAt) return []
  const moved = []
  for (const gen of migrated) {
    const target = `${gen.path}.superseded-${now}`
    renameSync(gen.path, target)
    moved.push(target)
  }
  return moved
}

function findSessionFiles() {
  if (!existsSync(SESSIONS_ROOT)) return []
  const result = []
  for (const projectDir of readdirSync(SESSIONS_ROOT)) {
    const projectPath = join(SESSIONS_ROOT, projectDir)
    if (!statSync(projectPath).isDirectory()) continue
    for (const sessionDir of readdirSync(projectPath)) {
      const sessionPath = join(projectPath, sessionDir)
      if (!statSync(sessionPath).isDirectory()) continue
      const filePath = currentSessionLog(sessionPath)
      if (!filePath) continue
      result.push({
        path: filePath,
        project: projectDir,
        sessionDir,
        mtime: statSync(filePath).mtimeMs,
      })
    }
  }
  return result.sort((a, b) => b.mtime - a.mtime)
}

function readSessionMeta(entry) {
  try {
    const events = decodeSessionJsonl(entry.path)
    const header = events[0]
    // Count turn boundaries + assistant messages để bot phân biệt session
    // rỗng vs session có nội dung. Packed rows (text-chunks) count as many
    // events chỉ có 1 row — bot dùng number để status/handoff.
    const turns = events.filter(e => e.type === 'turn/start').length
    const assistantMessages = events.filter(e => e.type === 'assistant/message').length
    const toolCalls = events.filter(e => e.type === 'tool/call').length
    return {
      session_id: header?.id ?? null,
      cwd: header?.cwd ?? null,
      created_at: header?.createdAt ?? null,
      agent_preset: header?.agentPreset ?? null,
      turns,
      assistant_messages: assistantMessages,
      tool_calls: toolCalls,
      events: events.length,
      last_modified: new Date(entry.mtime).toISOString(),
      path: entry.path,
    }
  } catch (e) {
    return {
      session_id: null,
      path: entry.path,
      error: e.message,
      last_modified: new Date(entry.mtime).toISOString(),
    }
  }
}

function sessionsList() {
  const entries = findSessionFiles()
  const list = entries.map(readSessionMeta)
  printJson({ sessions: list, count: list.length, root: SESSIONS_ROOT })
}

function sessionsLatest() {
  const entries = findSessionFiles()
  if (entries.length === 0) {
    return printJson({ session: null, note: 'chưa có session nào' })
  }
  printJson({ session: readSessionMeta(entries[0]) })
}

function sessionsShow(sessionId) {
  if (!sessionId) {
    errJson('internal_error', 'sessions show: cần truyền SESSION_ID', true, 0, 2)
  }
  const entries = findSessionFiles()
  const match = entries.find(e => {
    try {
      const events = decodeSessionJsonl(e.path)
      return events[0]?.id === sessionId
    } catch { return false }
  })
  if (!match) {
    errJson('internal_error', `session not found: ${sessionId}`, true, 0, 1)
  }
  const meta = readSessionMeta(match)
  const events = decodeSessionJsonl(match.path)
  // Preview: header + tail 20 events (không dump toàn bộ để tránh huge output)
  const tail = events.slice(-20).map(e => ({ seq: e.seq, type: e.type }))
  printJson({ ...meta, tail_events: tail })
}

// ── subscriptions login (Grok/Codex/Claude via dsh-plugin-subscriptions) ─
// Plugin lưu auth state ở ~/.dsh/plugins/subscriptions/auth.json (mode 600):
//   { "grok": {accessToken, refreshToken, expiresAt, tokenEndpoint, scopes, account},
//     "codex": {...},
//     "claude": {...} }
// OAuth PKCE flow của Grok/Codex + Claude Code credentials cần browser tương
// tác — không automate qua CLI được. Bot điều phối bằng cách:
//   1. Gọi `ahv login status` → biết provider nào đã login
//   2. Nếu chưa, gọi `ahv login url <provider>` → nhận URL web UI, forward
//      user Telegram → user OAuth qua browser → callback lưu file
//   3. Poll `ahv login status` để confirm login xong
//   4. `ahv logout <provider>` xoá token khi user request
const SUBSCRIPTIONS_AUTH_FILE = join(DSH_HOME, 'plugins/subscriptions/auth.json')
// User cài CLI local qua curl install.sh sẽ không có domain — mặc định
// trỏ về ahv web local (chạy bằng `ahv web` trước khi login). Anh Hiếu
// server prod set AHV_WEB_PUBLIC_URL=https://ahv.ahvclaw.com trong
// /etc/default/ahv-web để bot team dùng URL public. Env override luôn
// win, hoặc auto-detect systemd env file khi wrapper source ~/.ahv/env.
const SUBSCRIPTIONS_LOGIN_URL_BASE = process.env.AHV_WEB_PUBLIC_URL
  ?? 'http://127.0.0.1:3080'
const SUPPORTED_LOGIN_PROVIDERS = ['grok', 'codex', 'claude', 'antigravity']

function readSubscriptionsAuth() {
  if (!existsSync(SUBSCRIPTIONS_AUTH_FILE)) return {}
  try {
    return JSON.parse(readFileSync(SUBSCRIPTIONS_AUTH_FILE, 'utf8'))
  } catch (e) {
    return {}
  }
}

/**
 * The store for a read-modify-write: a missing file is empty, but a file that
 * exists and cannot be read throws. Treating it as empty would write back only
 * the change and erase every other account.
 */
function readSubscriptionsAuthForWrite() {
  if (!existsSync(SUBSCRIPTIONS_AUTH_FILE)) return {}
  const data = JSON.parse(readFileSync(SUBSCRIPTIONS_AUTH_FILE, 'utf8'))
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object')
  return data
}

/**
 * One provider's entry as {defaultKey, accounts}, whichever shape it is on disk.
 *
 * dsh-plugin-subscriptions 0.6 keeps several accounts per provider under
 * `{default, accounts}` and still accepts the older bare session. Reading only
 * the bare fields — as this file used to — meant that after the plugin wrote
 * the new shape every panel reported "chua login provider nay", and an entry
 * carrying both read as the stale one.
 *
 * @param entry - the provider's entry from the store.
 * @returns the default account key and every account, possibly empty.
 */
function storeAccounts(entry) {
  if (entry === null || typeof entry !== 'object') return { defaultKey: '', accounts: {} }
  const accounts = entry.accounts !== null && typeof entry.accounts === 'object' && !Array.isArray(entry.accounts)
    ? { ...entry.accounts }
    : {}
  let defaultKey = typeof entry.default === 'string' ? entry.default : ''
  if (typeof entry.accessToken === 'string' && entry.accessToken !== '') {
    const bare = { ...entry }
    delete bare.accounts
    delete bare.default
    const key = accountKeyOf(bare)
    if (key !== '' && !(key in accounts)) accounts[key] = bare
    if (defaultKey === '') defaultKey = key
  }
  if (!(defaultKey in accounts)) defaultKey = Object.keys(accounts)[0] ?? ''
  return { defaultKey, accounts }
}

/**
 * The address to show beside an account's figures.
 *
 * Codex sessions mirrored from the CLI carry only the raw token set — no
 * address — so a machine with two Codex logins listed two UUIDs, which is the
 * same "which one is this?" problem that naming the account was meant to end.
 * The id token already carries the address, so read it there rather than
 * asking the network.
 *
 * @param session - a stored session.
 * @param key - the account key, used when nothing better is known.
 * @returns an address, or the key.
 */
function accountLabel(session, key) {
  if (session !== null && typeof session === 'object') {
    const named = session.emailAddress ?? session.account
    if (typeof named === 'string' && named !== '') return named
    const token = session.idToken ?? session.id_token
    if (typeof token === 'string') {
      const parts = token.split('.')
      if (parts.length >= 2) {
        try {
          const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
          if (typeof claims.email === 'string' && claims.email !== '') return claims.email
        } catch { /* a malformed token is simply nameless */ }
      }
    }
  }
  return String(key ?? '')
}

/** The identity an account is filed under, matching the plugin's own keying. */
function accountKeyOf(session) {
  if (session === null || typeof session !== 'object') return ''
  return String(session.accountId ?? session.emailAddress ?? session.account ?? '')
}

/** The session a provider is currently logged in as, or undefined. */
function activeSession(entry) {
  const { defaultKey, accounts } = storeAccounts(entry)
  return defaultKey === '' ? undefined : accounts[defaultKey]
}

/**
 * Put a refreshed session back under one named account, leaving the rest alone.
 *
 * `withSession` writes to whichever account is default, which is right when the
 * default is the only one being refreshed. Once every account is refreshed —
 * so the panel can show what each has left — that same call would file each new
 * token under the default and overwrite the others with a session that is not
 * theirs. The key has to be carried through.
 *
 * @param entry - the provider's entry from the store.
 * @param key - the account the session belongs to.
 * @param session - the refreshed session.
 * @returns the entry with that one account replaced.
 */
export function withAccountSession(entry, key, session) {
  const { defaultKey, accounts } = storeAccounts(entry)
  if (key === '') return entry
  return { ...entryExtras(entry), default: defaultKey !== '' ? defaultKey : key, accounts: { ...accounts, [key]: session } }
}

/**
 * The fields of a multi-account entry besides its accounts (the plugin keeps
 * Codex `aliases` there); a bare single-session entry has none worth keeping.
 */
function entryExtras(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.accessToken === 'string') return {}
  const { default: _default, accounts: _accounts, ...extras } = entry
  return extras
}

/** Put a refreshed session back where it came from, leaving other accounts alone. */
function withSession(entry, session) {
  const { defaultKey, accounts } = storeAccounts(entry)
  const key = defaultKey !== '' ? defaultKey : accountKeyOf(session)
  if (key === '') return entry
  return { ...entryExtras(entry), default: key, accounts: { ...accounts, [key]: session } }
}

function writeSubscriptionsAuth(obj) {
  writeFileAtomic600(SUBSCRIPTIONS_AUTH_FILE, JSON.stringify(obj, null, 2))
}

// Copied from subscriptions 0.9.6 and dsh-llm attribution: importing the
// provider module also loads harness dependencies absent from standalone CLI.
const CLAUDE_CLI_FALLBACK_VERSION = '2.1.283'
const SUBSCRIPTIONS_USER_AGENT = `deepseek-harness/${harnessPackageVersion()} (+https://github.com/deepseek-ai/deepseek-harness)`
const ANTIGRAVITY_USER_AGENT = 'antigravity/1.104.0 dsh-plugin-subscriptions'
let localClaudeCliVersion

/** Read dsh-llm metadata without loading the harness; standalone copies keep the pinned version. */
function harnessPackageVersion() {
  for (const root of [FORK, resolvePath(HERE, '../..')]) {
    const manifest = join(root, 'packages/llm/llm/package.json')
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, 'utf8')).version
    for (const anchor of [join(root, 'packages/bundle/ahv/package.json'), join(root, 'package.json')]) {
      try { return createRequire(anchor)('@deepseek-ai/dsh-llm/package.json').version }
      catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error
      }
    }
  }
  return '0.2.0-rc.1'
}

/** Claude's local CLI version or the plugin's floor, probed once on first use. */
function claudeCliUserAgent() {
  if (localClaudeCliVersion === undefined) {
    let local = CLAUDE_CLI_FALLBACK_VERSION
    try {
      const raw = execFileSync('claude', ['--version'], {
        timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })
      local = raw.match(/(\d+\.\d+\.\d+)/)?.[1] ?? local
    } catch (error) {
      // Missing, unreadable or timed out CLI: the offline floor remains usable.
    }
    const detected = local.split('.').map(Number)
    const floor = CLAUDE_CLI_FALLBACK_VERSION.split('.').map(Number)
    const difference = detected.map((part, index) => part - floor[index]).find(part => part !== 0) ?? 0
    localClaudeCliVersion = difference > 0 ? local : CLAUDE_CLI_FALLBACK_VERSION
  }
  return `claude-cli/${localClaudeCliVersion} (external, cli)`
}

/**
 * Where each provider reports the quota left on the logged-in account.
 *
 * These are the same endpoints the subscriptions plugin calls. They are read
 * directly rather than by booting the harness: the console refreshes this on a
 * timer across every server, and a full plugin boot per refresh would cost far
 * more than the request itself. The trade is that a change to these endpoints
 * has to be mirrored here — the shape below is deliberately the plugin's.
 */
export const USAGE_ENDPOINTS = {
  claude: {
    url: 'https://api.anthropic.com/api/oauth/usage',
    headers: (s) => ({
      authorization: `Bearer ${s.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': claudeCliUserAgent(),
      accept: 'application/json',
    }),
  },
  codex: {
    url: 'https://chatgpt.com/backend-api/wham/usage',
    headers: (s) => ({
      authorization: `Bearer ${s.accessToken}`,
      'chatgpt-account-id': s.accountId,
      originator: 'codex_cli_rs',
      accept: 'application/json',
      'user-agent': SUBSCRIPTIONS_USER_AGENT,
    }),
  },
  // Antigravity answers a POST, not a GET: the same v1internal method agy's own
  // /usage calls, which reports each model family's weekly and 5-hour buckets.
  antigravity: {
    url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    method: 'POST',
    body: (s) => JSON.stringify(s.projectId ? { project: s.projectId } : {}),
    headers: (s) => ({
      authorization: `Bearer ${s.accessToken}`,
      'content-type': 'application/json',
      'user-agent': ANTIGRAVITY_USER_AGENT,
    }),
  },
  grok: {
    url: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    headers: (s) => ({
      authorization: `Bearer ${s.accessToken}`,
      'x-xai-token-auth': 'xai-grok-cli',
      accept: 'application/json',
      'user-agent': SUBSCRIPTIONS_USER_AGENT,
    }),
  },
}

/**
 * Where a provider swaps a refresh token for a new access token.
 *
 * The stored access token lives about eight hours. A host whose bot nobody
 * talks to never refreshes it, and asking for quota with a dead token made
 * Anthropic answer 429 "Rate limited" on some twenty servers at once — the
 * console read it as a real limit. The store already holds the refresh token;
 * this uses it the same way the subscriptions plugin does.
 */
export const REFRESH_ENDPOINTS = {
  claude: {
    url: 'https://claude.ai/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  },
  // Google's token endpoint wants a form body and the client secret. A session
  // issued to the Antigravity desktop client can only be refreshed with that
  // client, so the pair is the plugin's own (or the same env override it takes)
  // rather than a copy kept here.
  antigravity: {
    url: 'https://oauth2.googleapis.com/token',
    form: true,
    client: antigravityOAuthClient,
  },
}

/** The OAuth client the subscriptions plugin signs Antigravity in with. */
export async function antigravityOAuthClient() {
  const envId = process.env.ANTIGRAVITY_CLIENT_ID?.trim()
  if (envId) return { clientId: envId, clientSecret: process.env.ANTIGRAVITY_CLIENT_SECRET?.trim() ?? '' }
  const file = join(FORK, 'packages/bundle/ahv/node_modules/dsh-plugin-subscriptions/lib/providers/antigravity-oauth-client.js')
  const mod = await import(pathToFileURL(realpathSync(file)).href)
  return { clientId: mod.ANTIGRAVITY_DEFAULT_CLIENT_ID, clientSecret: mod.ANTIGRAVITY_DEFAULT_CLIENT_SECRET }
}

/** Refresh this long before expiry, so a token never dies mid-request. */
export const REFRESH_AHEAD_MS = 60_000

/**
 * Whether a stored session is due a refresh, by the rule both commands share.
 *
 * @param kind - provider id.
 * @param session - the stored session.
 * @param now - epoch ms.
 * @returns 'unsupported' when this file cannot refresh it (no refresh endpoint
 *   or no refresh token), 'fresh' when it outlives REFRESH_AHEAD_MS, else 'stale'.
 */
export function refreshNeed(kind, session, now = Date.now()) {
  if (REFRESH_ENDPOINTS[kind] === undefined || !session || typeof session.accessToken !== 'string') return 'unsupported'
  if (typeof session.refreshToken !== 'string' || session.refreshToken === '') return 'unsupported'
  const expiresAt = typeof session.expiresAt === 'number' ? session.expiresAt : 0
  return expiresAt > now + REFRESH_AHEAD_MS ? 'fresh' : 'stale'
}

/**
 * Refresh a stored session when its access token is expired or about to be.
 *
 * Never throws: a failed refresh is reported beside the stale session so the
 * quota call still runs and the console shows why it could not.
 *
 * @param kind - provider id.
 * @param session - the stored session for that provider.
 * @param fetchFn - injected for tests.
 * @param now - epoch ms, injected for tests.
 * @returns the session to use, whether it was refreshed, and the error if not;
 *   a failure also carries `failure`: 'invalid_grant', 'http' or 'network'.
 */
export async function refreshSessionIfStale(kind, session, fetchFn = fetch, now = Date.now()) {
  if (refreshNeed(kind, session, now) !== 'stale') return { session, refreshed: false }
  const endpoint = REFRESH_ENDPOINTS[kind]
  const scope = Array.isArray(session.scopes) ? session.scopes.join(' ') : session.scopes
  try {
    const client = endpoint.client ? await endpoint.client() : endpoint
    const response = await fetchFn(endpoint.url, endpoint.form
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
            client_id: client.clientId,
            client_secret: client.clientSecret,
          }).toString(),
        }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
            client_id: endpoint.clientId,
            ...(typeof scope === 'string' && scope !== '' ? { scope } : {}),
          }),
        })
    if (!response.ok) {
      const body = typeof response.text === 'function' ? String(await response.text()) : ''
      const detail = body.slice(0, 120)
      // The whole body is searched: the grant error can sit past the part shown.
      const dead = (response.status === 400 || response.status === 401) && body.includes('invalid_grant')
      return {
        session,
        refreshed: false,
        failure: dead ? 'invalid_grant' : 'http',
        error: `refresh HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      }
    }
    const tokens = await response.json()
    if (typeof tokens?.access_token !== 'string' || tokens.access_token === ''
      || typeof tokens?.expires_in !== 'number' || !(tokens.expires_in > 0)) {
      return { session, refreshed: false, failure: 'http', error: 'refresh returned no usable token' }
    }
    return {
      refreshed: true,
      session: {
        ...session,
        accessToken: tokens.access_token,
        refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token !== ''
          ? tokens.refresh_token : session.refreshToken,
        expiresAt: now + tokens.expires_in * 1000,
        ...(typeof tokens.scope === 'string' && tokens.scope !== '' ? { scopes: tokens.scope } : {}),
      },
    }
  } catch (error) {
    return {
      session,
      refreshed: false,
      failure: 'network',
      error: `refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** Keep a reported percentage inside the range a meter can draw. */
function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

function isoOrNull(value) {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 1e11 ? value : value * 1000).toISOString()
  }
  return null
}

const CODEX_SESSION_SECONDS = 5 * 60 * 60
const CODEX_WEEKLY_SECONDS = 7 * 24 * 60 * 60

/** Kind of a wham/usage window from its length (±5%), as the plugin does. */
function codexWindowKind(seconds, fallback) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return fallback
  const near = expected => seconds >= expected * 0.95 && seconds <= expected * 1.05
  if (near(CODEX_SESSION_SECONDS)) return 'session'
  if (near(CODEX_WEEKLY_SECONDS)) return 'weekly'
  return 'other'
}

/** Reset time of a wham/usage window: absolute `reset_at` first, then the countdown. */
function codexResetsAt(entry) {
  if (typeof entry.reset_at === 'number' && entry.reset_at > 0) return isoOrNull(entry.reset_at)
  for (const field of ['reset_after_seconds', 'resets_in_seconds']) {
    const seconds = entry[field]
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      return new Date(Date.now() + seconds * 1000).toISOString()
    }
  }
  return isoOrNull(entry.resets_at)
}

/** A short family label for an Antigravity quota group. */
function antigravityGroupScope(name) {
  const text = typeof name === 'string' ? name.trim() : ''
  if (/^gemini/i.test(text)) return 'Gemini'
  if (/claude/i.test(text)) return 'Claude + GPT'
  return text.replace(/\s+models?$/i, '')
}

/**
 * Turn one provider's payload into the same window list for all three.
 *
 * Each provider answers in its own shape — Claude in percentages, Codex in
 * rate-limit windows, Grok in credits — so the console would otherwise need
 * three renderers and would show nothing at all for a shape it did not know.
 *
 * @param kind - provider id.
 * @param payload - the provider's parsed JSON response.
 * @returns normalised windows, or supported:false when the shape is unknown.
 */
export function normaliseUsagePayload(kind, payload) {
  const windows = []
  const body = payload ?? {}
  if (kind === 'claude') {
    if (Array.isArray(body.limits)) {
      for (const entry of body.limits) {
        const pct = clampPercent(entry?.percent)
        if (pct === null) continue
        windows.push({
          kind: entry.kind === 'session' ? 'session'
            : (entry.kind === 'weekly_all' || entry.kind === 'weekly_scoped') ? 'weekly' : 'other',
          ...(typeof entry?.scope?.model?.display_name === 'string'
            ? { scope: entry.scope.model.display_name } : {}),
          used_percent: pct,
          resets_at: isoOrNull(entry?.resets_at),
        })
      }
    }
    // Only when the modern list is absent: the two describe the same limits, and
    // reporting both showed every window twice.
    if (windows.length === 0) {
      for (const [field, windowKind] of [['five_hour', 'session'], ['seven_day', 'weekly']]) {
        const legacy = body[field]
        const pct = clampPercent(legacy?.utilization)
        if (pct === null) continue
        windows.push({ kind: windowKind, used_percent: pct, resets_at: isoOrNull(legacy?.resets_at) })
      }
    }
  } else if (kind === 'codex') {
    // wham/usage puts a pro account's only (weekly) lane in primary_window
    // (#20, 16/09), so the slot said "5-hour session" and the reset was lost.
    // The window's own length decides its kind; slot order is only a fallback.
    for (const [field, fallbackKind] of [['primary_window', 'session'], ['secondary_window', 'weekly']]) {
      const entry = body.rate_limit?.[field]
      const pct = clampPercent(entry?.used_percent)
      if (pct === null) continue
      windows.push({
        kind: codexWindowKind(entry.limit_window_seconds, fallbackKind),
        used_percent: pct,
        resets_at: codexResetsAt(entry),
      })
    }
  } else if (kind === 'antigravity') {
    // Models share quota by family (Gemini; Claude and GPT), each with a weekly
    // and a 5-hour bucket. The family name is the scope, so the console can tell
    // a spent Claude lane from a Gemini lane that still has room.
    for (const group of Array.isArray(body.groups) ? body.groups : []) {
      const scope = antigravityGroupScope(group?.displayName)
      for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
        const remaining = bucket?.remainingFraction
        if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue
        windows.push({
          kind: bucket.window === 'weekly' ? 'weekly' : bucket.window === '5h' ? 'session' : 'other',
          ...(scope ? { scope } : {}),
          used_percent: clampPercent((1 - remaining) * 100),
          resets_at: isoOrNull(bucket.resetTime),
        })
      }
    }
  } else if (kind === 'grok') {
    // The live account reports a percentage over a billing period. A credits
    // balance is the older shape and is still accepted.
    const period = body.config?.currentPeriod ?? {}
    const periodKind = String(period.type ?? '').includes('WEEKLY') ? 'weekly' : 'session'
    const pct = clampPercent(body.config?.creditUsagePercent)
    if (pct !== null) {
      windows.push({ kind: periodKind, used_percent: pct, resets_at: isoOrNull(period.end) })
    } else if (isoOrNull(period.end) !== null) {
      // Some accounts get the weekly period with no creditUsagePercent at all
      // (#20, 15/09). Dropping the window left the console blank with no error,
      // as if Grok were not logged in; 0% would claim a figure Grok never gave.
      // The period is real, the percentage is unknown, and both are said so.
      windows.push({ kind: periodKind, used_percent: null, resets_at: isoOrNull(period.end) })
    }
    const total = Number(body.credits?.total)
    const remaining = Number(body.credits?.remaining)
    if (windows.length === 0 && Number.isFinite(total) && total > 0 && Number.isFinite(remaining)) {
      windows.push({
        kind: 'credits',
        used_percent: clampPercent(((total - remaining) / total) * 100),
        remaining,
        total,
        resets_at: isoOrNull(body.credits?.resets_at),
      })
    }
  }
  return windows.length > 0 ? { supported: true, windows } : { supported: false, windows: [] }
}

/**
 * Read one provider's remaining quota.
 *
 * Never throws: the console renders every server it knows about, and one
 * provider being unreachable or its token expired must show as that, beside the
 * ones that answered, rather than blanking the panel.
 *
 * @param kind - provider id.
 * @param session - the stored session for that provider.
 * @param fetchFn - injected for tests.
 * @returns normalised usage, or supported:false with a reason.
 */
export async function fetchProviderUsage(kind, session, fetchFn = fetch) {
  return (await readProviderUsage(kind, session, fetchFn)).result
}

/**
 * fetchProviderUsage, plus what the usage book needs from the HTTP answer.
 *
 * @param kind - provider id.
 * @param session - the stored session for that provider.
 * @param fetchFn - injected for tests.
 * @returns `result` as fetchProviderUsage; `status` (the HTTP status, or null
 *   when no request answered) and `retryAfter` (the raw Retry-After header or null).
 */
async function readProviderUsage(kind, session, fetchFn) {
  const endpoint = USAGE_ENDPOINTS[kind]
  if (endpoint === undefined) {
    return { status: null, retryAfter: null, result: { supported: false, windows: [], error: `unknown provider ${kind}` } }
  }
  if (!session || typeof session.accessToken !== 'string' || session.accessToken === '') {
    return { status: null, retryAfter: null, result: { supported: false, windows: [], error: 'chua login provider nay' } }
  }
  try {
    const response = await fetchFn(endpoint.url, {
      ...(endpoint.method ? { method: endpoint.method } : {}),
      headers: endpoint.headers(session),
      ...(endpoint.body ? { body: endpoint.body(session) } : {}),
    })
    if (!response.ok) {
      const detail = typeof response.text === 'function' ? String(await response.text()).slice(0, 120) : ''
      const retryAfter = typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : null
      return {
        status: response.status,
        retryAfter,
        result: { supported: false, windows: [], error: `HTTP ${response.status}${detail ? `: ${detail}` : ''}` },
      }
    }
    try {
      return { status: response.status, retryAfter: null, result: normaliseUsagePayload(kind, await response.json()) }
    } catch (error) {
      // A 2xx still resets the 429 sequence when its body cannot be read.
      return { status: response.status, retryAfter: null, result: { supported: false, windows: [], error: error instanceof Error ? error.message : String(error) } }
    }
  } catch (error) {
    return { status: null, retryAfter: null, result: { supported: false, windows: [], error: error instanceof Error ? error.message : String(error) } }
  }
}

// ── refresh book and usage book ─────────────────────────────────────────
// `ahv login usage` used to ask every account's quota and re-try every dead
// refresh token on every call. With the CMS agent and login-sync both calling
// it, each account was asked ~11 times an hour per machine: Anthropic answered
// 429 with Retry-After ~2800–3450 s and kept answering it, and ~15 machines
// sent refresh tokens already refused (`invalid_grant`) every ten minutes
// (fleet, 29/09). Two small files beside the store remember what the last call
// learnt. Neither holds a token: a refresh token is known only by a hash.

/** Hold a refresh token the provider refused (`invalid_grant`) this long. */
export const REFRESH_DEAD_HOLD_MS = 6 * 60 * 60_000
/** Hold after a 429, a 5xx or another HTTP failure of the refresh call. */
export const REFRESH_HTTP_HOLD_MS = 30 * 60_000
/** Hold after the refresh call never got an answer. */
export const REFRESH_NETWORK_HOLD_MS = 10 * 60_000
/** Longest usage hold before adding 0–10% jitter. */
export const USAGE_RETRY_AFTER_CAP_MS = 6 * 60 * 60_000
/** Retry-After fallback before applying the exponential usage hold. */
export const USAGE_RETRY_DEFAULT_MS = 5 * 60_000
/** Oldest last reading offered in place of a throttled account's figures. */
export const USAGE_STALE_READING_MS = 24 * 60 * 60_000

const REFRESH_HOLD_MS = {
  invalid_grant: REFRESH_DEAD_HOLD_MS,
  http: REFRESH_HTTP_HOLD_MS,
  network: REFRESH_NETWORK_HOLD_MS,
}

/**
 * A refresh token's identity in the refresh book, without the token.
 *
 * A new refresh token — the account logged in again, or login-sync brought a
 * live one — gets a new fingerprint, so a hold left by the old one never
 * delays it.
 *
 * @param refreshToken - the refresh token.
 * @returns the first 16 hex digits of its SHA-256.
 */
export function refreshTokenFingerprint(refreshToken) {
  return createHash('sha256').update(String(refreshToken)).digest('hex').slice(0, 16)
}

/**
 * Milliseconds a usage 429 asks to wait, from its Retry-After header.
 *
 * @param header - the raw header (delta-seconds or an HTTP date), or null.
 * @param now - epoch ms.
 * @returns the wait, capped at USAGE_RETRY_AFTER_CAP_MS; USAGE_RETRY_DEFAULT_MS
 *   when the header is absent or unreadable.
 */
export function retryAfterMs(header, now = Date.now()) {
  const text = typeof header === 'string' ? header.trim() : ''
  let wait = null
  if (/^\d+$/.test(text)) wait = Number(text) * 1000
  else if (text !== '') {
    const at = Date.parse(text)
    if (Number.isFinite(at)) wait = Math.max(0, at - now)
  }
  if (wait === null) return USAGE_RETRY_DEFAULT_MS
  return Math.min(wait, USAGE_RETRY_AFTER_CAP_MS)
}

/**
 * One book file held in memory: `{kind: {key: entry}}` plus the entries changed.
 *
 * Only changed entries are written back, onto a fresh read of the file, so two
 * commands running at once each keep the other's accounts.
 */
function bookOf(data) {
  const store = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const touched = new Set()
  return {
    get: (kind, key) => store[kind]?.[key],
    set(kind, key, entry) {
      touched.add(JSON.stringify([kind, key]))
      if (store[kind] === undefined || typeof store[kind] !== 'object') store[kind] = {}
      if (entry === undefined) delete store[kind][key]
      else store[kind][key] = entry
    },
    changes: () => [...touched].map(t => {
      const [kind, key] = JSON.parse(t)
      return { kind, key, entry: store[kind]?.[key] }
    }),
  }
}

/** A book file's contents, or {} when absent or unreadable (it is only a memo). */
function readBookFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // Missing or torn: the book only saves requests, so starting empty is safe.
    return {}
  }
}

/** Write a book's changed entries onto a fresh read of its file, atomically, 0600. */
function writeBookFile(file, book) {
  const changes = book.changes()
  if (changes.length === 0) return
  const current = readBookFile(file)
  for (const { kind, key, entry } of changes) {
    if (current[kind] === undefined || typeof current[kind] !== 'object') current[kind] = {}
    if (entry === undefined) delete current[kind][key]
    else current[kind][key] = entry
    if (Object.keys(current[kind]).length === 0) delete current[kind]
  }
  writeFileAtomic600(file, JSON.stringify(current, null, 2))
}

/** Replace a file with tmp + rename, so a reader never sees half of it. */
function writeFileAtomic600(file, text) {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/**
 * Refresh one account unless the refresh book says the answer is known.
 *
 * @param kind - provider id.
 * @param key - the account key.
 * @param session - the stored session.
 * @param book - the refresh book (see bookOf).
 * @param fetchFn - injected for tests.
 * @param now - epoch ms.
 * @returns refreshSessionIfStale's result plus `skipped` ('unsupported',
 *   'fresh', 'dead-refresh' or 'backoff') when no request was sent; a held
 *   account carries the error that put it on hold.
 */
async function refreshWithBook(kind, key, session, book, fetchFn, now) {
  const need = refreshNeed(kind, session, now)
  if (need !== 'stale') return { session, refreshed: false, skipped: need }
  const fp = refreshTokenFingerprint(session.refreshToken)
  const held = book.get(kind, key)
  if (held && held.fp === fp && typeof held.retry_at === 'number' && held.retry_at > now) {
    return {
      session,
      refreshed: false,
      skipped: held.failure === 'invalid_grant' ? 'dead-refresh' : 'backoff',
      ...(typeof held.error === 'string' ? { error: held.error } : {}),
    }
  }
  const fresh = await refreshSessionIfStale(kind, session, fetchFn, now)
  if (fresh.refreshed) {
    if (held) book.set(kind, key, undefined)
  } else if (fresh.error) {
    const failure = fresh.failure ?? 'http'
    book.set(kind, key, {
      fp,
      failure,
      error: fresh.error,
      failed_at: now,
      retry_at: now + (REFRESH_HOLD_MS[failure] ?? REFRESH_HTTP_HOLD_MS),
    })
  }
  return fresh
}

/** A cached reading's windows, minus those whose reset time has passed. */
function liveWindows(windows, now) {
  return (Array.isArray(windows) ? windows : []).filter(w => {
    const at = typeof w?.resets_at === 'string' ? Date.parse(w.resets_at) : NaN
    return !(Number.isFinite(at) && at <= now)
  })
}

/**
 * One account's usage, from the usage book when it may be, else the network.
 *
 * @param kind - provider id.
 * @param key - the account key.
 * @param session - the session to ask with.
 * @param cache - the usage book (see bookOf).
 * @param opts - fetchFn, now (epoch ms), maxAgeMs (null: always ask), randomFn.
 * @returns the fields fetchProviderUsage returns, plus `read_at` for a real
 *   reading, `cached` for one served from the book, and `throttled` with
 *   `retry_at` while a 429 holds the account.
 */
async function usageWithBook(kind, key, session, cache, { fetchFn, now, maxAgeMs, randomFn = Math.random }) {
  const memo = cache.get(kind, key)
  const reading = memo && typeof memo.read_at === 'number' ? memo : undefined
  const recent = (limit) => reading && now - reading.read_at <= limit
    ? { supported: reading.supported, windows: liveWindows(reading.windows, now), read_at: new Date(reading.read_at).toISOString() }
    : { supported: false, windows: [] }
  const throttled = (until, error) => ({
    ...recent(USAGE_STALE_READING_MS),
    // The CMS agent recognises a rate limit by this exact "HTTP 429" text.
    error,
    throttled: true,
    retry_at: new Date(until).toISOString(),
  })
  if (memo && typeof memo.throttled_until === 'number' && memo.throttled_until > now) {
    return throttled(memo.throttled_until, memo.throttle_error ?? 'HTTP 429')
  }
  if (maxAgeMs !== null && reading && now - reading.read_at <= maxAgeMs) {
    return { ...recent(maxAgeMs), cached: true }
  }
  const { result, status, retryAfter } = await readProviderUsage(kind, session, fetchFn)
  if (status === 429) {
    const previous = Number.isSafeInteger(memo?.consecutive_429) && memo.consecutive_429 > 0 ? memo.consecutive_429 : 0
    const consecutive = previous + 1
    const base = Math.min(USAGE_RETRY_AFTER_CAP_MS,
      Math.max(retryAfterMs(retryAfter, now), 60 * 60_000 * 2 ** Math.min(consecutive - 1, 3)))
    const until = now + Math.round(base * (1 + randomFn() * 0.1))
    cache.set(kind, key, { ...(memo ?? {}), consecutive_429: consecutive, throttled_until: until, throttle_error: result.error })
    return throttled(until, result.error)
  }
  if (status !== null && status >= 200 && status < 300) {
    if (result.error) {
      const { throttled_until: _until, throttle_error: _error, ...previous } = memo ?? {}
      cache.set(kind, key, { ...previous, consecutive_429: 0 })
      return result
    }
    cache.set(kind, key, { read_at: now, supported: result.supported, windows: result.windows, consecutive_429: 0 })
    return { ...result, read_at: new Date(now).toISOString() }
  }
  return result
}

/**
 * The quota left on every account of every provider, and any token refreshed.
 *
 * Separated from the command so it can be driven with a stub fetch: the shape
 * this returns is what the console draws, and it has to be right for a machine
 * holding two accounts where one is out of quota — the case that cannot be
 * reproduced by logging in twice on the build machine.
 *
 * @param auth - the subscriptions store, as read from disk.
 * @param fetchFn - injected for tests.
 * @param opts - `now` (epoch ms), `refreshBook` and `usageCache` (bookOf; an
 *   empty in-memory book when omitted, so nothing is read or written here), and
 *   `maxAgeSec` (serve readings this young from the usage book), `randomFn`.
 * @returns providers keyed by id, and the sessions whose tokens were renewed.
 */
export async function collectSubscriptionUsage(auth, fetchFn = fetch, opts = {}) {
  const now = opts.now ?? Date.now()
  const refreshBook = opts.refreshBook ?? bookOf({})
  const usageCache = opts.usageCache ?? bookOf({})
  const maxAgeMs = typeof opts.maxAgeSec === 'number' ? opts.maxAgeSec * 1000 : null
  const providers = {}
  const refreshed = []
  await Promise.all(SUPPORTED_LOGIN_PROVIDERS.map(async (kind) => {
    const stored = auth?.[kind]
    const { defaultKey, accounts } = storeAccounts(stored && typeof stored === 'object' ? stored : undefined)
    const rows = await Promise.all(Object.entries(accounts).map(async ([key, session]) => {
      const fresh = await refreshWithBook(kind, key, session, refreshBook, fetchFn, now)
      if (fresh.refreshed) refreshed.push({ kind, key, session: fresh.session })
      const held = fresh.skipped === 'dead-refresh' || fresh.skipped === 'backoff'
      return {
        key,
        account: accountLabel(session, key),
        is_default: key === defaultKey,
        logged_in: Boolean(session && session.accessToken),
        ...(await usageWithBook(kind, key, fresh.session, usageCache, { fetchFn, now, maxAgeMs, randomFn: opts.randomFn })),
        ...(fresh.refreshed ? { refreshed: true } : {}),
        ...(fresh.error ? { refresh_error: fresh.error } : {}),
        ...(held ? { refresh_skipped: fresh.skipped } : {}),
      }
    }))
    // The default's figures stay at the top level, unchanged, so a console or
    // an agent that predates this reads exactly what it read before.
    const primary = rows.find(row => row.is_default)
    providers[kind] = {
      logged_in: Boolean(primary && primary.logged_in),
      ...(primary
        ? { supported: primary.supported, windows: primary.windows, ...(primary.error ? { error: primary.error } : {}) }
        : await fetchProviderUsage(kind, undefined, fetchFn)),
      accounts: rows,
    }
  }))
  return { providers, refreshed }
}

/**
 * Report the quota left on every account, not only the one in use.
 *
 * A machine can hold several logins per provider, and only the default was ever
 * asked — so the console showed one number and no way to see what the others
 * had left. Choosing which account to run as meant switching to it first and
 * looking afterwards, which is exactly the wrong order when the one in use has
 * just run out.
 *
 * Every account is refreshed on the way past, so the accounts kept in reserve
 * stay usable instead of quietly expiring while they wait — except a refresh
 * token the refresh book holds. An account under a usage 429 is not asked
 * again until its exponential hold plus jitter passes; `--max-age SEC` answers accounts read at
 * most SEC seconds ago from the usage book.
 */
async function loginUsage(args) {
  let maxAgeSec
  const flag = args.indexOf('--max-age')
  if (flag !== -1) {
    const value = args[flag + 1]
    if (value === undefined || !/^\d+$/.test(value)) {
      errJson('internal_error', 'login usage: --max-age cần số giây (số nguyên >= 0)', true, 0, 2)
    }
    maxAgeSec = Number(value)
  }
  printJson(await loginUsageReport({ maxAgeSec }), 0)
}

/** Parse the targeted quota command before any provider request can run. */
async function loginQuota(args) {
  const options = {}
  const flags = { '--kind': 'kind', '--account': 'account', '--max-age': 'maxAgeSec' }
  try {
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]
      if (flag === '--json') continue
      const name = Object.hasOwn(flags, flag) ? flags[flag] : undefined
      if (!name || Object.hasOwn(options, name)) throw new Error(`login quota: cờ không hợp lệ hoặc lặp: ${flag}`)
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`login quota: ${flag} cần giá trị`)
      if (name === 'maxAgeSec') {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
          throw new Error('login quota: --max-age cần số giây (số nguyên >= 0)')
        }
        options[name] = Number(value)
      } else options[name] = value
    }
    printJson(await loginQuotaReport(options), 0)
  } catch (error) {
    errJson('internal_error', error.message, true, 0, 1)
  }
}

/** Where the refresh book and the usage book live: beside the store. */
const REFRESH_BOOK_FILE = join(dirname(SUBSCRIPTIONS_AUTH_FILE), 'refresh-state.json')
const USAGE_BOOK_FILE = join(dirname(SUBSCRIPTIONS_AUTH_FILE), 'usage-cache.json')

/**
 * What `ahv login usage` prints, with the store and both books updated.
 *
 * @param opts - `fetchFn` and `now` (injected for tests); `maxAgeSec` answers
 *   accounts read at most that long ago from the usage book; `randomFn` supplies
 *   the usage 429 jitter sample (0–1).
 * @returns `{checked_at, providers}` as collectSubscriptionUsage builds it.
 */
export async function loginUsageReport({ fetchFn = fetch, now = Date.now(), maxAgeSec, randomFn = Math.random } = {}) {
  const refreshBook = bookOf(readBookFile(REFRESH_BOOK_FILE))
  const usageCache = bookOf(readBookFile(USAGE_BOOK_FILE))
  const { providers, refreshed } = await collectSubscriptionUsage(readSubscriptionsAuth(), fetchFn, {
    now, refreshBook, usageCache, maxAgeSec, randomFn,
  })
  persistRefreshed(refreshed)
  writeBookFile(REFRESH_BOOK_FILE, refreshBook)
  writeBookFile(USAGE_BOOK_FILE, usageCache)
  return { checked_at: new Date(now).toISOString(), providers }
}

/**
 * Read selected accounts' quota without refreshing tokens or writing auth.
 *
 * Uses login usage's cache and 429 holds. Expired access tokens produce an
 * error row without a provider request, even if a cached reading exists.
 * The provider summary uses the default row when selected, otherwise the first row.
 * @param opts - `kind`, optional account key and `maxAgeSec`; `fetchFn`, `now`
 *   and `randomFn` can be injected. maxAgeSec=0 always asks unless held by 429.
 * @returns `{checked_at, providers: {kind: {accounts, ...primaryFields}}}`.
 * @throws when the kind/account does not exist or maxAgeSec is invalid.
 */
export async function loginQuotaReport({ kind, account, maxAgeSec, fetchFn = fetch, now = Date.now(), randomFn = Math.random } = {}) {
  if (!SUPPORTED_LOGIN_PROVIDERS.includes(kind)) throw new Error(`login quota: kind "${kind ?? ''}" không hỗ trợ`)
  if (maxAgeSec !== undefined && (!Number.isSafeInteger(maxAgeSec) || maxAgeSec < 0)) {
    throw new Error('login quota: --max-age cần số giây (số nguyên >= 0)')
  }
  const auth = readSubscriptionsAuth()
  const { defaultKey, accounts } = storeAccounts(auth[kind])
  if (Object.keys(accounts).length === 0) throw new Error(`login quota: kind "${kind}" không có tài khoản`)
  if (account !== undefined && !Object.hasOwn(accounts, account)) {
    throw new Error(`login quota: account "${account}" không có trong kind "${kind}"`)
  }
  const selected = account === undefined ? Object.entries(accounts) : [[account, accounts[account]]]
  const usageCache = bookOf(readBookFile(USAGE_BOOK_FILE))
  const maxAgeMs = maxAgeSec === undefined || maxAgeSec === 0 ? null : maxAgeSec * 1000
  const rows = await Promise.all(selected.map(async ([key, session]) => ({
    key,
    account: accountLabel(session, key),
    is_default: key === defaultKey,
    logged_in: Boolean(session && session.accessToken),
    ...(typeof session?.expiresAt === 'number' && session.expiresAt <= now
      ? { supported: false, windows: [], error: 'access token đã hết hạn; dùng ahv login refresh để làm mới' }
      : await usageWithBook(kind, key, session, usageCache, { fetchFn, now, maxAgeMs, randomFn })),
  })))
  const primary = rows.find(row => row.is_default) ?? rows[0]
  const provider = {
    logged_in: Boolean(primary && primary.logged_in),
    ...(primary
      ? { supported: primary.supported, windows: primary.windows, ...(primary.error ? { error: primary.error } : {}) }
      : await fetchProviderUsage(kind, undefined, fetchFn)),
    accounts: rows,
  }
  writeBookFile(USAGE_BOOK_FILE, usageCache)
  return { checked_at: new Date(now).toISOString(), providers: { [kind]: provider } }
}

/**
 * File refreshed sessions back into the store.
 *
 * Re-reads before writing: another process may have refreshed meanwhile, and a
 * token issued later must never be replaced by an older one.
 *
 * @param refreshed - `{kind, key, session}` for each session renewed.
 */
function persistRefreshed(refreshed) {
  if (refreshed.length === 0) return
  let current
  try {
    current = readSubscriptionsAuthForWrite()
  } catch (e) {
    process.stderr.write(`ahv login usage: ${SUBSCRIPTIONS_AUTH_FILE} không đọc được (${e.message}) — không ghi token vừa làm mới\n`)
    return
  }
  let changed = false
  for (const { kind, key, session } of refreshed) {
    const existing = storeAccounts(current[kind]).accounts[key]
    const existingExpiry = existing && typeof existing.expiresAt === 'number' ? existing.expiresAt : 0
    if (existingExpiry >= session.expiresAt) continue
    // Back into the account it came from: writing the bare session at the
    // top of the entry is what shadowed a live login with a stale one.
    current[kind] = withAccountSession(current[kind], key, session)
    changed = true
  }
  if (changed) writeSubscriptionsAuth(current)
}

/**
 * Renew the sessions about to expire, and ask nothing else.
 *
 * login-sync's keepalive called `ahv login usage` only to keep tokens alive,
 * which also asked every account's quota each time and added to the 429s.
 * This sends a request only for a session within REFRESH_AHEAD_MS of expiry
 * whose refresh token the refresh book does not hold.
 *
 * @param opts - `fetchFn` and `now`, injected for tests.
 * @returns `{checked_at, providers: {kind: {accounts: [{key, account,
 *   is_default, expires_at, refreshed, refresh_error?, skipped?}]}}}`.
 * @throws when the store exists but cannot be read or parsed.
 */
export async function loginRefreshReport({ fetchFn = fetch, now = Date.now() } = {}) {
  const auth = existsSync(SUBSCRIPTIONS_AUTH_FILE) ? JSON.parse(readFileSync(SUBSCRIPTIONS_AUTH_FILE, 'utf8')) : {}
  const refreshBook = bookOf(readBookFile(REFRESH_BOOK_FILE))
  const refreshed = []
  const providers = {}
  await Promise.all(SUPPORTED_LOGIN_PROVIDERS.map(async (kind) => {
    const stored = auth?.[kind]
    const { defaultKey, accounts } = storeAccounts(stored && typeof stored === 'object' ? stored : undefined)
    const rows = await Promise.all(Object.entries(accounts).map(async ([key, session]) => {
      const fresh = await refreshWithBook(kind, key, session, refreshBook, fetchFn, now)
      if (fresh.refreshed) refreshed.push({ kind, key, session: fresh.session })
      return {
        key,
        account: accountLabel(session, key),
        is_default: key === defaultKey,
        expires_at: typeof fresh.session?.expiresAt === 'number' ? fresh.session.expiresAt : null,
        refreshed: fresh.refreshed === true,
        ...(fresh.error ? { refresh_error: fresh.error } : {}),
        ...(fresh.skipped ? { skipped: fresh.skipped } : {}),
      }
    }))
    providers[kind] = { accounts: rows }
  }))
  persistRefreshed(refreshed)
  writeBookFile(REFRESH_BOOK_FILE, refreshBook)
  return { checked_at: new Date(now).toISOString(), providers }
}

async function loginRefresh() {
  let report
  try {
    report = await loginRefreshReport()
  } catch (e) {
    errJson('internal_error', `không đọc được ${SUBSCRIPTIONS_AUTH_FILE}: ${e.message}`, true, 0, 1)
  }
  printJson(report, 0)
}

function loginStatus() {
  const auth = readSubscriptionsAuth()
  const providers = {}
  for (const p of SUPPORTED_LOGIN_PROVIDERS) {
    const { defaultKey, accounts } = storeAccounts(auth[p])
    const entry = defaultKey === '' ? undefined : accounts[defaultKey]
    if (entry && typeof entry === 'object') {
      providers[p] = {
        logged_in: true,
        // KHÔNG expose token/refreshToken/PKCE state — chỉ metadata safe
        account: entry.emailAddress ?? entry.account ?? null,
        expires_at: entry.expiresAt ?? null,
        scopes: Array.isArray(entry.scopes) ? entry.scopes : null,
        // Plugin 0.6+ giữ nhiều tài khoản mỗi provider; CMS cần biết đang
        // dùng cái nào và còn cái nào để chọn.
        account_key: defaultKey,
        account_count: Object.keys(accounts).length,
      }
    } else {
      providers[p] = { logged_in: false, account: null, expires_at: null, scopes: null }
    }
  }
  printJson({
    ahv_web_url: SUBSCRIPTIONS_LOGIN_URL_BASE,
    providers,
  }, 0)
}

function loginUrl(provider) {
  if (!provider) errJson('internal_error', 'login url: cần truyền provider (grok|codex|claude|antigravity)', true, 0, 2)
  if (!SUPPORTED_LOGIN_PROVIDERS.includes(provider)) {
    errJson('internal_error', `provider "${provider}" không hỗ trợ. Chỉ: ${SUPPORTED_LOGIN_PROVIDERS.join(', ')}`, true, 0, 2)
  }
  const isLocal = SUBSCRIPTIONS_LOGIN_URL_BASE.startsWith('http://127.0.0.1')
    || SUBSCRIPTIONS_LOGIN_URL_BASE.startsWith('http://localhost')
  printJson({
    provider,
    url: `${SUBSCRIPTIONS_LOGIN_URL_BASE}/`,
    web_public: !isLocal,
    instruction: isLocal
      ? `1. Chạy \`ahv web\` để bật local web UI (nếu chưa chạy). ` +
        `2. Mở ${SUBSCRIPTIONS_LOGIN_URL_BASE}/ trong browser trên cùng máy. ` +
        `3. Vào Settings → Subscriptions, chọn "${provider}", làm OAuth flow. ` +
        `4. Token lưu tại ${SUBSCRIPTIONS_AUTH_FILE} (mode 600). ` +
        `5. \`ahv login status --json\` để verify.`
      : `Mở URL trong browser, đăng nhập, vào Settings → Subscriptions, ` +
        `chọn "${provider}", làm OAuth flow. ` +
        `Token lưu tại ${SUBSCRIPTIONS_AUTH_FILE} (mode 600). ` +
        `Sau khi xong, gọi \`ahv login status --json\` để verify.`,
    poll_hint: 'Poll `ahv login status --json` mỗi 30s tối đa 10ph, providers[<name>].logged_in=true là xong.',
    note: isLocal
      ? 'Default local URL. Set AHV_WEB_PUBLIC_URL env nếu web UI expose ra domain public.'
      : `Public URL từ env AHV_WEB_PUBLIC_URL=${SUBSCRIPTIONS_LOGIN_URL_BASE}.`,
  }, 0)
}

/**
 * List one provider's stored accounts, default first, without any token.
 *
 * The CMS shows these so an operator can see which ChatGPT account a machine
 * is actually running on when several are logged in.
 *
 * @param provider - provider id.
 */
function loginAccounts(provider) {
  if (!provider) errJson('internal_error', 'accounts: cần truyền provider', true, 0, 2)
  if (!SUPPORTED_LOGIN_PROVIDERS.includes(provider)) {
    errJson('internal_error', `provider "${provider}" không hỗ trợ`, true, 0, 2)
  }
  const { defaultKey, accounts } = storeAccounts(readSubscriptionsAuth()[provider])
  const rows = Object.entries(accounts).map(([key, session]) => ({
    key,
    is_default: key === defaultKey,
    account: session.emailAddress ?? session.account ?? null,
    plan: session.planType ?? session.subscriptionType ?? session.plan ?? null,
    expires_at: typeof session.expiresAt === 'number' ? session.expiresAt : null,
  }))
  rows.sort((a, b) => Number(b.is_default) - Number(a.is_default))
  printJson({ provider, default: defaultKey === '' ? null : defaultKey, accounts: rows }, 0)
}

/**
 * Point a provider at one of its stored accounts.
 *
 * The login sync then pushes that account down to the CLI, so the bot and the
 * usage panel follow the same choice.
 *
 * @param provider - provider id.
 * @param key - the account key from `login accounts`.
 */
/** The store for a login command that writes it; refuses (exit 1) when the file cannot be read. */
function authForWrite() {
  try {
    return readSubscriptionsAuthForWrite()
  } catch (e) {
    return errJson('internal_error', `${SUBSCRIPTIONS_AUTH_FILE} không đọc được (${e.message}) — không ghi đè kho`, true, 0, 1)
  }
}

function loginUse(provider, key) {
  if (!provider || !key) errJson('internal_error', 'use: cần truyền provider và account key', true, 0, 2)
  if (!SUPPORTED_LOGIN_PROVIDERS.includes(provider)) {
    errJson('internal_error', `provider "${provider}" không hỗ trợ`, true, 0, 2)
  }
  const auth = authForWrite()
  const { defaultKey, accounts } = storeAccounts(auth[provider])
  if (!(key in accounts)) {
    errJson('internal_error', `account "${key}" chưa có trong kho của ${provider}`, true, 0, 2)
  }
  if (defaultKey !== key) {
    auth[provider] = { ...entryExtras(auth[provider]), default: key, accounts }
    try {
      writeSubscriptionsAuth(auth)
    } catch (e) {
      errJson('permission_denied', `không ghi được ${SUBSCRIPTIONS_AUTH_FILE}: ${e.message}`, true, 0, 1)
    }
  }
  printJson({ provider, default: key, changed: defaultKey !== key }, 0)
}

/**
 * Forget one stored account, keeping the provider's other logins.
 *
 * @param provider - provider id.
 * @param key - the account key from `login accounts`.
 */
function loginForget(provider, key) {
  if (!provider || !key) errJson('internal_error', 'forget: cần truyền provider và account key', true, 0, 2)
  if (!SUPPORTED_LOGIN_PROVIDERS.includes(provider)) {
    errJson('internal_error', `provider "${provider}" không hỗ trợ`, true, 0, 2)
  }
  const auth = authForWrite()
  const { defaultKey, accounts } = storeAccounts(auth[provider])
  const existed = key in accounts
  if (existed) {
    delete accounts[key]
    const nextDefault = defaultKey === key ? (Object.keys(accounts)[0] ?? '') : defaultKey
    if (Object.keys(accounts).length === 0) delete auth[provider]
    else auth[provider] = { ...entryExtras(auth[provider]), default: nextDefault, accounts }
    try {
      writeSubscriptionsAuth(auth)
    } catch (e) {
      errJson('permission_denied', `không ghi được ${SUBSCRIPTIONS_AUTH_FILE}: ${e.message}`, true, 0, 1)
    }
  }
  const { defaultKey: after } = storeAccounts(auth[provider])
  printJson({ provider, forgot: key, was_present: existed, default: after === '' ? null : after }, 0)
}

function loginLogout(provider) {
  if (!provider) errJson('internal_error', 'logout: cần truyền provider', true, 0, 2)
  if (!SUPPORTED_LOGIN_PROVIDERS.includes(provider)) {
    errJson('internal_error', `provider "${provider}" không hỗ trợ`, true, 0, 2)
  }
  const auth = authForWrite()
  const wasLoggedIn = Boolean(auth[provider])
  if (wasLoggedIn) {
    delete auth[provider]
    try {
      writeSubscriptionsAuth(auth)
    } catch (e) {
      errJson('permission_denied', `không ghi được ${SUBSCRIPTIONS_AUTH_FILE}: ${e.message}`, true, 0, 1)
    }
  }
  printJson({
    provider,
    logged_out: true,
    was_logged_in: wasLoggedIn,
    note: wasLoggedIn ? 'token đã xoá khỏi auth.json — cần restart ahv-web service để plugin refresh routes' : 'provider chưa từng login',
  }, 0)
}

// ── models ──────────────────────────────────────────────────────────────
// Nguồn thật của model list là ctx.llm.listProviders() + listModels() ở
// harness của mình — bao gồm mọi LLM plugin đã mount (llm-pi-ai / AHV
// router, dsh-plugin-subscriptions sau khi user OAuth, và bất cứ adapter
// nào khác). Spawn dsh với patch bot-list-models: plugin mount, dump JSON
// catalog rồi exit. Fallback về static parser nếu spawn fail.
function spawnListModels() {
  return new Promise((resolve) => {
    const patch = join(FORK, 'packages/bundle/ahv/cordis.patch.list-models.yml')
    const ahvPatch = join(FORK, 'packages/bundle/ahv/cordis.patch.yml')
    const args = [
      '--import', 'tsx/esm',
      join(FORK, 'apps/cli/src/bin.ts'),
      '--profile', 'headless',
      '--patch', ahvPatch,
      '--patch', patch,
    ]
    const env = { ...process.env, NO_COLOR: '1' }
    const proc = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: FORK,
    })
    let stdout = '', stderr = ''
    proc.stdout.on('data', b => stdout += b.toString('utf8'))
    proc.stderr.on('data', b => stderr += b.toString('utf8'))
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }))
    // Cold dsh + plugin fetch subscription models qua network có thể vượt
    // 60s (Codex Plus/Claude Pro/Grok Premium mỗi lần fetch model list mất
    // 5-20s + boot dsh tree ~20s). Bump 120s để tránh timeout kill khi bot
    // gọi từ user Telegram lần đầu sau restart.
    setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 120000)
  })
}

// Fallback đọc plugin cache khi spawn dsh fail — plugin đã lưu models
// list vào ~/.dsh/plugins/subscriptions/models.json (mỗi provider có
// {at: timestamp, models: [...]}). Bot có sẵn kết quả cached ngay, không
// phải chờ spawn lần sau.
const SUBSCRIPTIONS_MODELS_CACHE = join(DSH_HOME, 'plugins/subscriptions/models.json')
/**
 * Restore providers that a live listing lost, from the cache.
 *
 * The harness lists each provider separately and drops any that does not answer
 * in time, so the same command has returned 32, then 22, then 29 models — the
 * model the operator picked could simply be absent that minute.
 *
 * Only providers with a live session are restored. The cache once carried
 * Claude entries for a user who had never logged in, which made an unwired
 * subscription look present; a cache is evidence of what a provider offers, not
 * of whether this machine may use it.
 *
 * @param liveModels - models the harness returned this time.
 * @param cache - the subscriptions model cache, as read from disk.
 * @param loggedInProviders - provider ids that currently hold a session.
 * @returns the merged list and which providers were restored from cache.
 */
/**
 * Provider ids that currently hold a session in the subscriptions store.
 *
 * Read from the store rather than the model cache: the cache says what a
 * provider offers, not whether this machine is allowed to use it.
 * @param home - the user's home directory.
 * @returns the logged-in provider ids.
 */
export function readLoggedInProviders(home = homedir()) {
  const storePath = join(home, '.dsh', 'plugins', 'subscriptions', 'auth.json')
  if (!existsSync(storePath)) return []
  try {
    const store = JSON.parse(readFileSync(storePath, 'utf8'))
    return Object.entries(store)
      .filter(([, entry]) => typeof entry?.accessToken === 'string' && entry.accessToken !== '')
      .map(([provider]) => provider)
  } catch {
    return []
  }
}

export function topUpMissingProviders(liveModels, cache, loggedInProviders) {
  const models = [...liveModels]
  const restored = []
  const cached = Array.isArray(cache?.models) ? cache.models : []
  if (cached.length === 0) return { models, restored }
  const present = new Set(liveModels.map(m => m.provider))
  const allowed = new Set(loggedInProviders ?? [])
  for (const entry of cached) {
    const provider = entry?.provider
    if (typeof provider !== 'string') continue
    if (present.has(provider) || !allowed.has(provider)) continue
    if (!restored.includes(provider)) restored.push(provider)
    models.push({
      id: entry.model_id,
      name: entry.model_name ?? entry.model_id,
      provider,
      provider_name: entry.provider_name ?? provider,
      context_window: entry.context_window ?? null,
      max_tokens: entry.max_tokens ?? null,
      pinned: false,
      stale: true,
    })
  }
  return { models, restored }
}

function readSubscriptionsModelsCache() {
  if (!existsSync(SUBSCRIPTIONS_MODELS_CACHE)) return { providers: [], models: [] }
  try {
    const data = JSON.parse(readFileSync(SUBSCRIPTIONS_MODELS_CACHE, 'utf8'))
    const providers = []
    const models = []
    const PROVIDER_NAMES = {
      grok: 'Grok (Subscription)',
      codex: 'ChatGPT (Codex)',
      claude: 'Claude (Subscription)',
    }
    for (const [provider, entry] of Object.entries(data)) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.models)) continue
      const provName = PROVIDER_NAMES[provider] ?? provider
      providers.push({ id: provider, name: provName })
      for (const m of entry.models) {
        if (typeof m?.id !== 'string') continue
        models.push({
          provider,
          provider_name: provName,
          model_id: m.id,
          model_name: m.name,
          context_window: m.contextWindow,
          max_tokens: m.maxTokens,
        })
      }
    }
    return { providers, models }
  } catch { return { providers: [], models: [] } }
}

// Static parser giữ để fallback khi spawn dsh fail (thiếu credential,
// plugin tree không mount được, etc). Chỉ có AHV router models declared.
function readStaticAhvModels() {
  const patchPath = join(FORK, 'packages/bundle/ahv/cordis.patch.yml')
  if (!existsSync(patchPath)) return []
  const text = readFileSync(patchPath, 'utf8')
  // Scan for `models:` block trong llm-pi-ai config. Each model entry is
  // `- id: <id>` với indented fields sau đó. Kết thúc block khi encounter
  // dòng ngoài cùng level của `models:` (top-level list `- id: xxx` hoặc
  // key `providers:` etc). Không dùng full YAML parser vì cordis.patch.yml
  // có `!!js` tags mà js-yaml không handle không có schema riêng.
  const models = []
  const lines = text.split('\n')
  let modelsIndent = -1   // -1 = not in section
  let entryIndent = -1
  let cur = null
  for (const raw of lines) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const trimmed = raw.trim()

    if (trimmed === 'models:') {
      modelsIndent = indent
      continue
    }
    if (modelsIndent < 0) continue

    // Kết thúc block khi encounter dòng cùng hoặc thấp hơn modelsIndent
    if (indent <= modelsIndent) {
      if (cur) { models.push(cur); cur = null }
      modelsIndent = -1
      entryIndent = -1
      continue
    }

    // Model entry: `- id: X` bên trong models block
    const entryMatch = /^-\s+id:\s+(.+)$/.exec(trimmed)
    if (entryMatch) {
      if (cur) models.push(cur)
      cur = { id: entryMatch[1].replace(/^['"]|['"]$/g, '').trim(), source: 'static' }
      entryIndent = indent
      continue
    }

    // Nested field bên trong entry hiện tại
    if (cur && indent > entryIndent) {
      const fieldMatch = /^(name|contextWindow|maxTokens):\s+(.+)$/.exec(trimmed)
      if (fieldMatch) {
        const key = fieldMatch[1]
        const val = key === 'name'
          ? fieldMatch[2].replace(/^['"]|['"]$/g, '')
          : Number(fieldMatch[2])
        cur[key] = val
      }
    }
  }
  if (cur) models.push(cur)
  return models
}

async function fetchRouterModels() {
  const key = process.env.AHV_API_KEY
  if (!key) return { ok: false, error: 'missing_credential', models: [] }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(`${DEFAULT_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, models: [] }
    const body = await res.json()
    const models = (body.data ?? []).map(m => ({
      id: m.id,
      name: m.id,
      provider: 'ahv-router',
      source: 'router',
    }))
    return { ok: true, models }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, models: [] }
  }
}

async function modelsList() {
  // Primary: spawn dsh với list-models patch, đọc catalog từ ctx.llm.
  // Bao gồm mọi LLM plugin đang mount (subscriptions ChatGPT/Claude/Grok
  // sau OAuth, llm-pi-ai router, etc). Đây là source of truth.
  const result = await spawnListModels()
  if (result.code === 0 && result.stdout.trim()) {
    try {
      const lines = result.stdout.trim().split('\n')
      const jsonLine = [...lines].reverse().find(l => l.trim().startsWith('{'))
      if (!jsonLine) throw new Error('no JSON line in dsh stdout')
      const payload = JSON.parse(jsonLine)
      const staticModels = readStaticAhvModels()
      const staticById = new Map(staticModels.map(m => [m.id, m]))
      // Merge static metadata (contextWindow, maxTokens) vào catalog live.
      const models = payload.models.map(m => {
        const s = staticById.get(m.model_id)
        return {
          id: m.model_id,
          name: m.model_name ?? m.model_id,
          provider: m.provider,
          provider_name: m.provider_name,
          context_window: m.context_window ?? s?.contextWindow ?? null,
          max_tokens: m.max_tokens ?? s?.maxTokens ?? null,
          pinned: Boolean(s),
        }
      })
      // A provider that failed to answer this time would otherwise disappear
      // from the catalog, and with it the model the operator had chosen.
      const { models: merged, restored } = topUpMissingProviders(
        models,
        readSubscriptionsModelsCache(),
        readLoggedInProviders(),
      )
      const providers = [...payload.providers]
      for (const id of restored) {
        if (!providers.some(p => p.id === id)) {
          providers.push({ id, name: merged.find(m => m.provider === id)?.provider_name ?? id })
        }
      }
      return printJson({
        default: DEFAULT_MODEL,
        provider_count: providers.length,
        providers,
        count: merged.length,
        source: 'harness',   // ctx.llm.listProviders() + listModels()
        ...(restored.length > 0 ? { restored_from_cache: restored } : {}),
        models: merged,
      }, 0)
    } catch (e) {
      // JSON parse fail — fall through to static fallback
    }
  }
  // Fallback: dsh spawn fail/timeout. Đọc từ plugin cache
  // ~/.dsh/plugins/subscriptions/models.json để bot vẫn có full subscription
  // catalog + merge với static AHV. Bot không thấy 'empty' khi cold spawn.
  const staticModels = readStaticAhvModels()
  const sub = readSubscriptionsModelsCache()
  if (sub.models.length > 0) {
    const staticById = new Map(staticModels.map(m => [m.id, m]))
    const combined = [
      ...sub.models.map(m => ({
        id: m.model_id,
        name: m.model_name ?? m.model_id,
        provider: m.provider,
        provider_name: m.provider_name,
        context_window: m.context_window ?? null,
        max_tokens: m.max_tokens ?? null,
        pinned: false,
      })),
      ...staticModels.map(m => ({
        id: m.id,
        name: m.name ?? m.id,
        provider: 'ahv-router',
        provider_name: 'AHV Router',
        context_window: m.contextWindow ?? null,
        max_tokens: m.maxTokens ?? null,
        pinned: true,
      })),
    ]
    return printJson({
      default: DEFAULT_MODEL,
      provider_count: sub.providers.length + 1,
      providers: [...sub.providers, { id: 'ahv-router', name: 'AHV Router' }],
      count: combined.length,
      source: 'cache-fallback',
      fallback_reason: result.stderr.slice(0, 200) || `exit ${result.code}`,
      models: combined,
    }, 0)
  }
  // Cache cũng trống → static only
  printJson({
    default: DEFAULT_MODEL,
    provider_count: 1,
    providers: [{ id: 'ahv-router', name: 'AHV Router' }],
    count: staticModels.length,
    source: 'static-fallback',
    fallback_reason: result.stderr.slice(0, 200) || `exit ${result.code}`,
    models: staticModels.map(m => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: 'ahv-router',
      provider_name: 'AHV Router',
      context_window: m.contextWindow ?? null,
      max_tokens: m.maxTokens ?? null,
      pinned: true,
    })),
  }, 0)
}

async function modelsShow(modelId) {
  if (!modelId) errJson('internal_error', 'models show: cần truyền MODEL_ID', true, 0, 2)
  const result = await spawnListModels()
  let harness = null
  if (result.code === 0 && result.stdout.trim()) {
    try {
      const lines = result.stdout.trim().split('\n')
      const jsonLine = [...lines].reverse().find(l => l.trim().startsWith('{'))
      if (jsonLine) {
        const payload = JSON.parse(jsonLine)
        harness = payload.models.find(m => m.model_id === modelId)
      }
    } catch { /* fall through */ }
  }
  const staticModels = readStaticAhvModels()
  const s = staticModels.find(m => m.id === modelId)
  if (!harness && !s) {
    errJson('internal_error', `model not found: ${modelId}`, true, 0, 1)
  }
  printJson({
    id: modelId,
    name: harness?.model_name ?? s?.name ?? modelId,
    provider: harness?.provider ?? 'ahv-router',
    provider_name: harness?.provider_name ?? 'AHV Router',
    context_window: harness?.context_window ?? s?.contextWindow ?? null,
    max_tokens: harness?.max_tokens ?? s?.maxTokens ?? null,
    pinned: Boolean(s),
    mounted_in_harness: Boolean(harness),
  }, 0)
}

/**
 * Watch dsh's stderr for the bot runner failing to mount.
 *
 * dsh 0.2 reports a plugin row that did not activate as a warning block
 * ("dsh: warning: N entries did not activate", then one "<id> (<name>): <why>"
 * line per row) and keeps running. Without the runner nothing ever exits, so
 * this turns that into the bot's terminal error instead of a hang.
 *
 * @param onFailure - called once with the offending line.
 * @returns a sink for stderr chunks.
 */
export function runnerLoadWatcher(onFailure) {
  let pending = ''
  let fired = false
  return (chunk) => {
    if (fired) return
    pending += chunk.toString('utf8')
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (/^bot-(runner|startup) \([^)]*\): /.test(line.trim())) {
        fired = true
        onFailure(line.trim())
        return
      }
    }
  }
}

// ── run (spawn dsh headless + ahv patch + bot patch) ───────────────────
export const SYSTEM_FILE_MAX_BYTES = 64 * 1024

/**
 * Strip `--system-file PATH` from the `ahv run` arguments and carry the file's
 * text to dsh as AHV_BOT_SYSTEM_SUFFIX, which the bot patch passes to bot-runner
 * as systemSuffix (appended verbatim). Without the flag the variable is removed, so a run
 * started from inside a bot turn does not inherit that turn's instructions.
 * @param {string[]} argv - arguments after `run`.
 * @param {Record<string, string | undefined>} env - environment for dsh; not mutated.
 * @returns {{ argv: string[], env: Record<string, string | undefined> }} arguments for dsh and its environment.
 * @throws {Error} message starting `system_file_invalid` when the path is missing, unreadable, over 64 KiB, or not UTF-8, or the flag is repeated or written `--system-file=PATH`.
 */
export function prepareBotEnv(argv, env) {
  const out = { ...env }
  delete out.AHV_BOT_SYSTEM_SUFFIX
  if (argv.some(a => a.startsWith('--system-file='))) throw new Error('system_file_invalid: dùng --system-file PATH, không dùng dạng --system-file=PATH')
  const at = argv.indexOf('--system-file')
  if (at < 0) return { argv, env: out }
  if (argv.indexOf('--system-file', at + 2) >= 0) throw new Error('system_file_invalid: --system-file chỉ được dùng một lần')
  const path = argv[at + 1]
  if (path === undefined || path === '') throw new Error('system_file_invalid: --system-file cần đường dẫn tệp')
  let bytes
  try { bytes = readFileSync(path) } catch (e) { throw new Error(`system_file_invalid: không đọc được ${path}: ${e.code ?? e.message}`) }
  if (bytes.length > SYSTEM_FILE_MAX_BYTES) throw new Error(`system_file_invalid: ${path} ${bytes.length} byte, quá ${SYSTEM_FILE_MAX_BYTES}`)
  try { out.AHV_BOT_SYSTEM_SUFFIX = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error(`system_file_invalid: ${path} không phải UTF-8`) }
  return { argv: [...argv.slice(0, at), ...argv.slice(at + 2)], env: out }
}

// Reuse the working ahv-profile module-resolution: cwd=FORK so pnpm's hoisted
// @deepseek-ai/* deps resolve, and --patch layers apply on top of headless.
function runBot(rawArgv) {
  // dsh prints the headless app's own help after this line.
  if (rawArgv.includes('--help') || rawArgv.includes('-h')) {
    process.stdout.write(`ahv run: --system-file PATH   lời dặn thêm vào cuối system prompt cho lần gọi này (nguyên văn, không nội suy {{…}}, UTF-8, ≤ ${SYSTEM_FILE_MAX_BYTES} byte)\n`)
  }
  // Contract #3: fail-fast credential check TRƯỚC khi spawn dsh. Nếu thiếu
  // key, emit JSONL error taxonomy đúng chuẩn để bot phân loại terminal,
  // không lãng phí boot dsh cả tree chỉ để router silent-fail.
  const outputMode = rawArgv.includes('--output') ? rawArgv[rawArgv.indexOf('--output') + 1] : 'jsonl'
  if (!process.env.AHV_API_KEY) {
    if (outputMode === 'jsonl') {
      process.stdout.write(JSON.stringify({
        type: 'error',
        code: 'missing_credential',
        terminal: true,
        retry_after_sec: 0,
        message: 'AHV_API_KEY chưa được set — cài qua ~/.ahv/env hoặc /etc/default/ahv-web',
      }) + '\n')
    } else {
      process.stderr.write('ahv run: missing_credential (AHV_API_KEY chưa set)\n')
    }
    process.exit(1)
  }
  let argv, env
  try {
    ({ argv, env } = prepareBotEnv(rawArgv, { ...process.env, NO_COLOR: '1' }))
  } catch (e) {
    errJson('system_file_invalid', e.message, true, 0, 2)
  }
  const resumeAt = argv.indexOf('--resume')
  const resumeId = resumeAt >= 0 ? argv[resumeAt + 1] : undefined
  if (resumeId && /^[A-Za-z0-9._-]+$/.test(resumeId) && existsSync(SESSIONS_ROOT)) {
    for (const project of readdirSync(SESSIONS_ROOT)) {
      const dir = join(SESSIONS_ROOT, project, resumeId)
      try {
        if (!statSync(dir).isDirectory()) continue
        for (const moved of supersedeStaleGenerations(dir)) {
          process.stderr.write(`ahv: log cũ mới hơn bản đã nâng (vừa lùi bản?) — nâng lại từ log cũ; cất ${moved}\n`)
        }
      } catch { /* not this project, or unreadable: dsh reports it */ }
    }
  }
  const AHV_PATCH = join(FORK, 'packages/bundle/ahv/cordis.patch.yml')
  const BOT_PATCH = join(FORK, 'packages/bundle/ahv/cordis.patch.bot.yml')
  // Use tsx-based source launch (--import tsx/esm src/bin.ts), same as dev
  // wrapper. Compiled lib/bin.js loses tsx's tsconfig-paths workspace
  // resolver — Node's native ESM resolver can't find workspace packages
  // like @deepseek-ai/dsh-tool-terminal from the profile dir.
  const dshArgs = [
    '--import', 'tsx/esm',
    join(FORK, 'apps/cli/src/bin.ts'),
    '--profile', 'headless',
    '--patch', AHV_PATCH,
    '--patch', BOT_PATCH,
    '--',
    ...argv,
  ]
  const proc = spawn(process.execPath, dshArgs, {
    // stderr is relayed, not inherited: dsh 0.2 only warns when a plugin row
    // fails to load, so a bot-runner that cannot mount leaves the process
    // alive with nothing to drive it and the caller waits out its timeout.
    stdio: ['inherit', 'inherit', 'pipe'],
    env,
    cwd: FORK,
    detached: true,   // đặt child vào process group riêng để kill -TERM -pgid diệt cả subtree
  })
  const watchRunner = runnerLoadWatcher((detail) => {
    try { process.kill(-proc.pid, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch {} }
    errJson('internal_error', `AHV bot runner không nạp được: ${detail}`, true, 0, 1)
  })
  proc.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
    watchRunner(chunk)
  })
  let cancelled = false
  const forward = (sig) => {
    cancelled = true
    // Kill toàn process group của child; -PID nghĩa là process group id
    try { process.kill(-proc.pid, sig) } catch { try { proc.kill(sig) } catch {} }
    // Grace 5s rồi force SIGKILL toàn subtree, tránh treo mãi
    setTimeout(() => {
      try { process.kill(-proc.pid, 'SIGKILL') } catch {}
      process.exit(124)
    }, 5000).unref()
  }
  process.on('SIGTERM', forward)
  process.on('SIGINT', forward)
  proc.on('close', (code, signal) => {
    if (cancelled || signal === 'SIGTERM' || signal === 'SIGINT') process.exit(124)
    process.exit(code ?? 1)
  })
  proc.on('error', (err) => errJson('internal_error', `dsh spawn failed: ${err.message}`, true, 0, 1))
}

// ── dispatch ────────────────────────────────────────────────────────────
// ── CLI-native credential import ────────────────────────────────────────
// `claude` credentials are already shared: the subscriptions plugin reads
// ~/.claude/.credentials.json directly. `codex` and `grok` are not — each
// keeps its own OAuth store, so a user who ran `codex login` still had to
// repeat the flow through AHV. These helpers translate the CLI-native stores
// into the plugin's schema so one login per CLI is enough.

/**
 * Read the `exp` claim from a JWT without verifying its signature.
 * Only the expiry is needed, and the token itself is already trusted local
 * state written by the CLI that owns it.
 * @param {string} token - a JWT.
 * @returns {number | null} expiry in epoch milliseconds, or null when absent.
 */
export function decodeJwtExpiry(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/** Translate ~/.codex/auth.json into the plugin's codex session shape. */
function readCodexCliSession(home) {
  const path = join(home, '.codex', 'auth.json')
  if (!existsSync(path)) return { session: null, reason: 'cli_not_logged_in' }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { session: null, reason: 'cli_unreadable' }
  }
  const tokens = raw?.tokens
  if (!tokens?.access_token || !tokens?.refresh_token) {
    return { session: null, reason: 'cli_not_logged_in' }
  }
  const expiresAt = decodeJwtExpiry(tokens.access_token)
  return {
    session: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: expiresAt ?? Date.now(),
      accountId: tokens.account_id ?? null,
      idToken: tokens.id_token ?? null,
    },
    reason: null,
  }
}

/** Translate ~/.grok/auth.json into the plugin's grok session shape. */
/**
 * Read the Claude login the `claude` CLI stores.
 *
 * The subscriptions plugin never runs an OAuth flow for Claude: it copies this
 * file. A user who has never run `claude` therefore has no Claude provider at
 * all — and a request naming a Claude model still answers, having fallen
 * through to the router, so the gap looks like everything is fine.
 *
 * `CLAUDE_CONFIG_DIR` is honoured because the plugin honours it: pointing it at
 * an existing login is how one account is shared by every CLI on a server.
 * @param home - the user's home directory.
 * @param claudeConfigDir - overrides where the login is read from.
 * @returns the session to store, or why there is none.
 */
function readClaudeCliSession(home, claudeConfigDir) {
  const dir = claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')
  const path = join(dir, '.credentials.json')
  if (!existsSync(path)) return { session: null, reason: 'cli_not_logged_in' }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { session: null, reason: 'cli_unreadable' }
  }
  const oauth = raw?.claudeAiOauth ?? raw
  const accessToken = oauth?.accessToken ?? oauth?.access_token
  const refreshToken = oauth?.refreshToken ?? oauth?.refresh_token
  if (!accessToken || !refreshToken) return { session: null, reason: 'cli_not_logged_in' }
  const expiresAt = oauth?.expiresAt ?? oauth?.expires_at ?? decodeJwtExpiry(accessToken)
  const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes : undefined
  return {
    session: {
      accessToken,
      refreshToken,
      expiresAt: typeof expiresAt === 'number' ? expiresAt : Date.now(),
      ...(scopes === undefined ? {} : { scopes }),
      ...(typeof oauth?.emailAddress === 'string' ? { emailAddress: oauth.emailAddress } : {}),
      ...(typeof oauth?.subscriptionType === 'string' ? { subscriptionType: oauth.subscriptionType } : {}),
    },
    reason: null,
  }
}

function readGrokCliSession(home) {
  const path = join(home, '.grok', 'auth.json')
  if (!existsSync(path)) return { session: null, reason: 'cli_not_logged_in' }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { session: null, reason: 'cli_unreadable' }
  }
  const accessToken = raw?.access_token ?? raw?.accessToken
  const refreshToken = raw?.refresh_token ?? raw?.refreshToken
  if (!accessToken || !refreshToken) return { session: null, reason: 'cli_not_logged_in' }
  const expiresAt = raw?.expires_at ?? raw?.expiresAt ?? decodeJwtExpiry(accessToken)
  return {
    session: {
      accessToken,
      refreshToken,
      expiresAt: typeof expiresAt === 'number' ? expiresAt : Date.now(),
      tokenEndpoint: raw?.token_endpoint ?? 'https://auth.x.ai/oauth2/token',
      account: raw?.email ?? raw?.account ?? null,
    },
    reason: null,
  }
}

/**
 * Import codex/grok/claude credentials from their CLI-native stores into the
 * subscriptions plugin store. An existing plugin entry with a later expiry
 * wins, so a token the plugin refreshed itself is never rolled back to the
 * older copy the CLI still holds. Other providers and accounts in the store are
 * preserved, and a store that exists but cannot be read is left alone rather
 * than replaced.
 * @param {{home?: string, claudeConfigDir?: string, fetchFn?: typeof fetch}} options - overrides for tests.
 * @returns {Promise<Record<string, {imported: boolean, reason: string | null}>>} per-provider outcome.
 */
export async function importCliCredentials({ home = homedir(), claudeConfigDir, fetchFn = fetch } = {}) {
  const storePath = join(home, '.dsh', 'plugins', 'subscriptions', 'auth.json')
  let store = {}
  if (existsSync(storePath)) {
    try {
      store = JSON.parse(readFileSync(storePath, 'utf8'))
    } catch {
      store = null
    }
    if (store === null || typeof store !== 'object' || Array.isArray(store)) {
      return Object.fromEntries(['codex', 'grok', 'claude'].map(p => [p, { imported: false, reason: 'store_unreadable' }]))
    }
  }

  const readers = {
    codex: readCodexCliSession,
    grok: readGrokCliSession,
    claude: (userHome) => readClaudeCliSession(userHome, claudeConfigDir),
  }
  const report = {}
  let changed = false

  for (const [provider, read] of Object.entries(readers)) {
    const { session: read$, reason } = read(home)
    if (!read$) {
      report[provider] = { imported: false, reason }
      continue
    }
    // Fields the CLI file lacks come through as null; they must not blank what the store knows.
    const session = Object.fromEntries(Object.entries(read$).filter(([, value]) => value !== null && value !== undefined))
    if (provider === 'claude' && session.emailAddress === undefined) {
      const email = await claudeProfileEmail(session.accessToken, fetchFn)
      if (email !== '') session.emailAddress = email
    }
    const existing = store[provider]
    // A store the plugin already keeps per account takes the login into one
    // account: spreading the bare session over it would make the plugin read
    // the entry as a single legacy session and drop every other account.
    const perAccount = existing !== null && typeof existing === 'object' && typeof existing.accessToken !== 'string'
      && existing.accounts !== null && typeof existing.accounts === 'object' && !Array.isArray(existing.accounts)
    const key = perAccount ? importAccountKey(provider, session, existing) : ''
    const current = perAccount ? existing.accounts[key] : existing
    const existingExpiry = typeof current?.expiresAt === 'number' ? current.expiresAt : 0
    if (existingExpiry >= session.expiresAt) {
      report[provider] = { imported: false, reason: 'plugin_token_newer' }
      continue
    }
    store[provider] = perAccount ? withAccountSession(existing, key, { ...current, ...session }) : { ...existing, ...session }
    report[provider] = { imported: true, reason: null }
    changed = true
  }

  if (changed) writeFileAtomic600(storePath, JSON.stringify(store, null, 2))
  return report
}

/**
 * The address of the Claude account an access token belongs to, asked of the
 * provider (Claude Code's credentials file carries none); "" when unknown.
 * Without it an imported login could only be filed under a hash of its refresh
 * token — a new, duplicate account after every CLI refresh — and guessing the
 * address from ~/.claude.json can name another account than the token's.
 */
async function claudeProfileEmail(accessToken, fetchFn) {
  try {
    const res = await fetchFn('https://api.anthropic.com/api/oauth/profile', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return ''
    const email = (await res.json())?.account?.email
    return typeof email === 'string' ? email : ''
  } catch {
    // Offline or refused: the login is filed without an address instead.
    return ''
  }
}

/**
 * The key the subscriptions plugin files a session under (its `accountKeyOf`):
 * Codex by workspace plus the user (or email) in the id token, Claude by email,
 * the rest by account name, and an anonymous session by `token-` + a hash of
 * its refresh token.
 */
export function pluginAccountKey(provider, session) {
  const nonEmpty = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
  const anonymous = () => `token-${refreshTokenFingerprint(session.refreshToken)}`
  if (provider === 'codex') {
    let claims
    const token = session.idToken ?? session.id_token
    if (typeof token === 'string') {
      try {
        claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
      } catch { /* a malformed id token carries no identity */ }
    }
    const auth = claims?.['https://api.openai.com/auth']
    const user = nonEmpty(auth?.chatgpt_user_id) ?? nonEmpty(auth?.user_id)
    const email = nonEmpty(session.emailAddress) ?? nonEmpty(claims?.email) ?? nonEmpty(claims?.['https://api.openai.com/profile']?.email)
    if (user === undefined && email === undefined) return String(session.accountId ?? '')
    return JSON.stringify([session.accountId, user === undefined ? 'email' : 'user', user ?? email.toLowerCase()])
  }
  if (provider === 'claude') return nonEmpty(session.emailAddress) ?? anonymous()
  return nonEmpty(session.account) ?? anonymous()
}

/**
 * The account an imported CLI login belongs to: the plugin's own key for it,
 * or an alias of that key, or the account already holding its refresh token;
 * a login matching none of them becomes a new account under the plugin's key.
 */
function importAccountKey(provider, session, entry) {
  const { accounts } = storeAccounts(entry)
  const key = pluginAccountKey(provider, session)
  if (key in accounts) return key
  const alias = entry?.aliases?.[key]
  if (typeof alias === 'string' && alias in accounts) return alias
  const same = Object.keys(accounts).find(k => accounts[k]?.refreshToken === session.refreshToken)
  return same ?? key
}

async function loginImport() {
  const report = await importCliCredentials()
  const importedCount = Object.values(report).filter(r => r.imported).length
  printJson({
    imported_count: importedCount,
    providers: report,
    note: 'claude lay tu CLAUDE_CONFIG_DIR hoac ~/.claude/.credentials.json.',
  }, 0)
}

const [subcommand, ...rest] = process.argv.slice(2)

function usage() {
  process.stderr.write(`Usage:
  ahv auth status --json                       (kiểm AHV_API_KEY router key)
  ahv auth login --device-auth                 (not supported — router dùng static key)
  ahv auth logout
  ahv doctor --json
  ahv login status --json                      (subscription plugin: Grok/Codex/Claude)
  ahv login url PROVIDER --json                (return browser OAuth URL)
  ahv login accounts PROVIDER --json           (liet ke cac tai khoan da luu)
  ahv login use PROVIDER ACCOUNT_KEY --json    (chon tai khoan mac dinh)
  ahv login forget PROVIDER ACCOUNT_KEY --json (xoa mot tai khoan, giu cac cai khac)
  ahv login logout PROVIDER --json             (remove stored token)
  ahv login import --json                      (import codex/grok CLI login vao AHV)
  ahv login usage --json [--max-age SEC]       (han muc con lai that tu grok/codex/claude)
  ahv login quota --json --kind K [--account KEY] [--max-age SEC] (chi hoi han muc, khong lam moi token)
  ahv login refresh --json                     (chi lam moi phien sap het han, khong hoi han muc)
  ahv models list --json
  ahv models show MODEL_ID --json
  ahv sessions list --json
  ahv sessions show SESSION_ID --json
  ahv sessions latest --json
  ahv run --prompt-file PATH --cwd DIR [--session-id ID | --resume ID] [--system-file PATH] --output jsonl --no-color --no-banner
  ahv version
`)
  process.exit(2)
}

// Deployments symlink ~/.ahv/bin per service user, so argv[1] is the
// symlinked path while import.meta.url is the real one. Compare resolved
// real paths: a raw URL comparison silently turns every subcommand into a
// no-op for any user reaching the CLI through a link.
const RUN_AS_CLI = (() => {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry)
  } catch {
    // An unresolvable entry path means we were not started as the CLI.
    return false
  }
})()

if (RUN_AS_CLI) {
if (!subcommand) usage()

if (subcommand === 'version') {
  try {
    const pkg = JSON.parse(readFileSync(join(FORK, 'apps/cli/package.json'), 'utf8'))
    printJson({ version: pkg.version, name: pkg.name, model_default: DEFAULT_MODEL })
  } catch { errJson('internal_error', 'cannot read version', true) }
} else if (subcommand === 'auth') {
  const action = rest[0]
  if (action === 'status') authStatus()
  else if (action === 'login') authLogin()
  else if (action === 'logout') authLogout()
  else usage()
} else if (subcommand === 'doctor') {
  doctor()
} else if (subcommand === 'login') {
  const action = rest[0]
  if (action === 'status') loginStatus()
  else if (action === 'url') loginUrl(rest[1])
  else if (action === 'accounts') loginAccounts(rest[1])
  else if (action === 'use') loginUse(rest[1], rest[2])
  else if (action === 'forget') loginForget(rest[1], rest[2])
  else if (action === 'logout') loginLogout(rest[1])
  else if (action === 'import') void loginImport()
  else if (action === 'usage') void loginUsage(rest.slice(1))
  else if (action === 'quota') void loginQuota(rest.slice(1))
  else if (action === 'refresh') void loginRefresh()
  else usage()
} else if (subcommand === 'models') {
  const action = rest[0]
  if (action === 'list') modelsList()
  else if (action === 'show') modelsShow(rest[1])
  else usage()
} else if (subcommand === 'sessions') {
  const action = rest[0]
  if (action === 'list') sessionsList()
  else if (action === 'latest') sessionsLatest()
  else if (action === 'show') sessionsShow(rest[1])
  else usage()
} else if (subcommand === 'run') {
  runBot(rest)
} else {
  usage()
}
}
