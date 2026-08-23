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

import { spawn } from 'node:child_process'
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { resolve as resolvePath, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'

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

  checks.push(checkProfileBundleLink(FORK, DSH_HOME))

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

function findSessionFiles() {
  if (!existsSync(SESSIONS_ROOT)) return []
  const result = []
  for (const projectDir of readdirSync(SESSIONS_ROOT)) {
    const projectPath = join(SESSIONS_ROOT, projectDir)
    if (!statSync(projectPath).isDirectory()) continue
    for (const sessionDir of readdirSync(projectPath)) {
      const sessionPath = join(projectPath, sessionDir)
      if (!statSync(sessionPath).isDirectory()) continue
      const jsonl = join(sessionPath, 'session.jsonl')
      const zstd = join(sessionPath, 'session.jsonl.zstd')
      let filePath = existsSync(zstd) ? zstd : existsSync(jsonl) ? jsonl : null
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
const SUPPORTED_LOGIN_PROVIDERS = ['grok', 'codex', 'claude']

function readSubscriptionsAuth() {
  if (!existsSync(SUBSCRIPTIONS_AUTH_FILE)) return {}
  try {
    return JSON.parse(readFileSync(SUBSCRIPTIONS_AUTH_FILE, 'utf8'))
  } catch (e) {
    return {}
  }
}

function writeSubscriptionsAuth(obj) {
  const dir = dirname(SUBSCRIPTIONS_AUTH_FILE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(SUBSCRIPTIONS_AUTH_FILE, JSON.stringify(obj, null, 2))
  chmodSync(SUBSCRIPTIONS_AUTH_FILE, 0o600)
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
      accept: 'application/json',
    }),
  },
  codex: {
    url: 'https://chatgpt.com/backend-api/wham/usage',
    headers: (s) => ({
      authorization: `Bearer ${s.accessToken}`,
      ...(s.accountId ? { 'chatgpt-account-id': s.accountId } : {}),
      originator: 'codex_cli_rs',
      accept: 'application/json',
    }),
  },
  grok: {
    url: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    headers: (s) => ({
      authorization: `Bearer ${s.accessToken}`,
      'x-xai-token-auth': 'xai-grok-cli',
      accept: 'application/json',
    }),
  },
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
    for (const [field, windowKind] of [['primary_window', 'session'], ['secondary_window', 'weekly']]) {
      const entry = body.rate_limit?.[field]
      const pct = clampPercent(entry?.used_percent)
      if (pct === null) continue
      const resets = typeof entry?.resets_in_seconds === 'number'
        ? new Date(Date.now() + entry.resets_in_seconds * 1000).toISOString()
        : isoOrNull(entry?.resets_at)
      windows.push({ kind: windowKind, used_percent: pct, resets_at: resets })
    }
  } else if (kind === 'grok') {
    // The live account reports a percentage over a billing period. A credits
    // balance is the older shape and is still accepted.
    const period = body.config?.currentPeriod ?? {}
    const pct = clampPercent(body.config?.creditUsagePercent)
    if (pct !== null) {
      windows.push({
        kind: String(period.type ?? '').includes('WEEKLY') ? 'weekly' : 'session',
        used_percent: pct,
        resets_at: isoOrNull(period.end),
      })
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
  const endpoint = USAGE_ENDPOINTS[kind]
  if (endpoint === undefined) return { supported: false, windows: [], error: `unknown provider ${kind}` }
  if (!session || typeof session.accessToken !== 'string' || session.accessToken === '') {
    return { supported: false, windows: [], error: 'chua login provider nay' }
  }
  try {
    const response = await fetchFn(endpoint.url, { headers: endpoint.headers(session) })
    if (!response.ok) {
      const detail = typeof response.text === 'function' ? String(await response.text()).slice(0, 120) : ''
      return { supported: false, windows: [], error: `HTTP ${response.status}${detail ? `: ${detail}` : ''}` }
    }
    return normaliseUsagePayload(kind, await response.json())
  } catch (error) {
    return { supported: false, windows: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/** Report the quota left on every logged-in subscription. */
async function loginUsage() {
  const auth = readSubscriptionsAuth()
  const providers = {}
  await Promise.all(SUPPORTED_LOGIN_PROVIDERS.map(async (kind) => {
    const entry = auth[kind]
    providers[kind] = {
      logged_in: Boolean(entry && typeof entry === 'object' && entry.accessToken),
      ...(await fetchProviderUsage(kind, entry)),
    }
  }))
  printJson({ checked_at: new Date().toISOString(), providers }, 0)
}

function loginStatus() {
  const auth = readSubscriptionsAuth()
  const providers = {}
  for (const p of SUPPORTED_LOGIN_PROVIDERS) {
    const entry = auth[p]
    if (entry && typeof entry === 'object') {
      providers[p] = {
        logged_in: true,
        // KHÔNG expose token/refreshToken/PKCE state — chỉ metadata safe
        account: entry.account ?? null,
        expires_at: entry.expiresAt ?? null,
        scopes: Array.isArray(entry.scopes) ? entry.scopes : null,
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
  if (!provider) errJson('internal_error', 'login url: cần truyền provider (grok|codex|claude)', true, 0, 2)
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

function loginLogout(provider) {
  if (!provider) errJson('internal_error', 'logout: cần truyền provider', true, 0, 2)
  if (!SUPPORTED_LOGIN_PROVIDERS.includes(provider)) {
    errJson('internal_error', `provider "${provider}" không hỗ trợ`, true, 0, 2)
  }
  const auth = readSubscriptionsAuth()
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

// ── run (spawn dsh headless + ahv patch + bot patch) ───────────────────
// Reuse the working ahv-profile module-resolution: cwd=FORK so pnpm's hoisted
// @deepseek-ai/* deps resolve, and --patch layers apply on top of headless.
function runBot(argv) {
  // Contract #3: fail-fast credential check TRƯỚC khi spawn dsh. Nếu thiếu
  // key, emit JSONL error taxonomy đúng chuẩn để bot phân loại terminal,
  // không lãng phí boot dsh cả tree chỉ để router silent-fail.
  const outputMode = argv.includes('--output') ? argv[argv.indexOf('--output') + 1] : 'jsonl'
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
  const env = { ...process.env, NO_COLOR: '1' }
  const proc = spawn(process.execPath, dshArgs, {
    stdio: ['inherit', 'inherit', 'inherit'],
    env,
    cwd: FORK,
    detached: true,   // đặt child vào process group riêng để kill -TERM -pgid diệt cả subtree
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
 * Import codex/grok credentials from their CLI-native stores into the
 * subscriptions plugin store. An existing plugin entry with a later expiry
 * wins, so a token the plugin refreshed itself is never rolled back to the
 * older copy the CLI still holds. Other providers in the store are preserved.
 * @param {{home?: string}} options - override HOME for tests.
 * @returns {Record<string, {imported: boolean, reason: string | null}>} per-provider outcome.
 */
export function importCliCredentials({ home = homedir(), claudeConfigDir } = {}) {
  const storePath = join(home, '.dsh', 'plugins', 'subscriptions', 'auth.json')
  let store = {}
  if (existsSync(storePath)) {
    try {
      store = JSON.parse(readFileSync(storePath, 'utf8')) ?? {}
    } catch {
      store = {}
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
    const { session, reason } = read(home)
    if (!session) {
      report[provider] = { imported: false, reason }
      continue
    }
    const existing = store[provider]
    const existingExpiry = typeof existing?.expiresAt === 'number' ? existing.expiresAt : 0
    if (existingExpiry >= session.expiresAt) {
      report[provider] = { imported: false, reason: 'plugin_token_newer' }
      continue
    }
    store[provider] = { ...existing, ...session }
    report[provider] = { imported: true, reason: null }
    changed = true
  }

  if (changed) {
    const dir = dirname(storePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(storePath, JSON.stringify(store, null, 2))
    chmodSync(storePath, 0o600)
  }
  return report
}

function loginImport() {
  const report = importCliCredentials()
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
  ahv login logout PROVIDER --json             (remove stored token)
  ahv login import --json                      (import codex/grok CLI login vao AHV)
  ahv login usage --json                       (han muc con lai that tu grok/codex/claude)
  ahv models list --json
  ahv models show MODEL_ID --json
  ahv sessions list --json
  ahv sessions show SESSION_ID --json
  ahv sessions latest --json
  ahv run --prompt-file PATH --cwd DIR [--session-id ID | --resume ID] --output jsonl --no-color --no-banner
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
  else if (action === 'logout') loginLogout(rest[1])
  else if (action === 'import') loginImport()
  else if (action === 'usage') void loginUsage()
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
