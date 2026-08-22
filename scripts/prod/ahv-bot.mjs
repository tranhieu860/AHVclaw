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
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
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
  process.stdout.write(JSON.stringify(obj) + '\n')
  process.exit(exitCode)
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
  const checks = []
  const nodeVersion = process.versions.node
  const nodeMajor = Number(nodeVersion.split('.')[0])
  checks.push({ name: 'node', ok: nodeMajor >= 22, value: `v${nodeVersion}`, required: '>=22' })

  try {
    const pnpmVer = (await execCapture('pnpm', ['-v'])).stdout.trim()
    const pnpmMajor = Number(pnpmVer.split('.')[0])
    checks.push({ name: 'pnpm', ok: pnpmMajor >= 10, value: pnpmVer, required: '>=10' })
  } catch (e) {
    checks.push({ name: 'pnpm', ok: false, value: null, error: 'not found' })
  }

  checks.push({ name: 'fork', ok: existsSync(FORK), value: FORK })
  checks.push({ name: 'cli_bin', ok: existsSync(join(FORK, 'apps/cli/lib/bin.js')), value: join(FORK, 'apps/cli/lib/bin.js') })
  checks.push({ name: 'ahv_bundle', ok: existsSync(join(FORK, 'packages/bundle/ahv/lib/bot-runner.js')), value: join(FORK, 'packages/bundle/ahv/lib/bot-runner.js') })
  checks.push({ name: 'bot_profile', ok: existsSync(join(DSH_HOME, 'profiles/bot/cordis.patch.yml')), value: join(DSH_HOME, 'profiles/bot/cordis.patch.yml') })

  const keyOk = Boolean(process.env.AHV_API_KEY)
  checks.push({ name: 'credential', ok: keyOk, value: keyOk ? 'set' : null, required: 'AHV_API_KEY env' })

  let sessionsDir = { name: 'sessions_dir', value: SESSIONS_ROOT, ok: false }
  try {
    if (!existsSync(SESSIONS_ROOT)) sessionsDir.error = 'not created yet'
    else if (!statSync(SESSIONS_ROOT).isDirectory()) sessionsDir.error = 'not a directory'
    else sessionsDir.ok = true
  } catch (e) { sessionsDir.error = e.message }
  checks.push(sessionsDir)

  const modelCheck = { name: 'model_route', value: DEFAULT_BASE_URL, ok: false }
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
    } catch (e) {
      modelCheck.error = e.name === 'AbortError' ? 'timeout' : e.message
    }
  } else {
    modelCheck.error = 'skipped (no AHV_API_KEY)'
  }
  checks.push(modelCheck)

  // Contract #4: doctor exit 0 khi command chạy xong + JSON hợp lệ.
  // `ok` field trong body báo trạng thái tổng; degraded route không làm
  // bot lỡ classify "cli broken" thành "route down". Exit non-zero chỉ
  // khi doctor không sinh được JSON hợp lệ (đã handled by errJson elsewhere).
  const allOk = checks.every(c => c.ok)
  printJson({
    ok: allOk,
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
  ahv auth status --json
  ahv auth login --device-auth
  ahv auth logout
  ahv doctor --json
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
