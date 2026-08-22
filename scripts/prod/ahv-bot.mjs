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
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
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
    setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 60000)
  })
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
      return printJson({
        default: DEFAULT_MODEL,
        provider_count: payload.provider_count,
        providers: payload.providers,
        count: models.length,
        source: 'harness',   // ctx.llm.listProviders() + listModels()
        models,
      }, 0)
    } catch (e) {
      // JSON parse fail — fall through to static fallback
    }
  }
  // Fallback: dsh không mount được (thiếu credential, tree broken, timeout).
  // Trả về static-declared AHV models để bot vẫn có options.
  const staticModels = readStaticAhvModels()
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
