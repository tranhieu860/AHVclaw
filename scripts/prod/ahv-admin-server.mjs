// AHV admin backend — CRUD over the bundled-plugin registry with a
// cookie-based session so we can show a custom login page (Caddy
// basic_auth's browser popup can't be styled). Listens on 127.0.0.1:3200.
// Caddy blindly reverse-proxies /admin/* here; auth lives in-app.

import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcryptjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID, createHmac, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 3200
const HOST = '127.0.0.1'
const STORE = '/srv/ahv-admin/plugins.json'
const APPLICATIONS_STORE = '/srv/ahv-admin/applications.json'
const STATIC_DIR = '/srv/ahv-admin'
const SECRET_FILE = '/opt/ahv-admin/.session-secret'
const COOKIE_NAME = 'ahv_sid'
const COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 30 // 30d
const TG_ENV_FILE = '/opt/bot/tg-claude-bot/.env'
const ADMIN_TG_CHAT_ID = '638048624' // Hiếu's chat, from telegram-delivery.sqlite3
const APPLY_RATE_LIMIT_MS = 60 * 60 * 1000 // 1 apply request / IP / hour

// Single hard-coded user. Password bcrypt hash for "Anhyeuem@123".
// Rotate: `node -e "console.log(require('bcryptjs').hashSync('<new>', 12))"`
// then paste over the string below and restart ahv-admin.
const USERS = {
  admin: '$2b$12$Jqbm4Stmm2VxxRZceTuLcOJKsZgFDvFxQepCtTj8mcq9y/SeXovRS',
}

// HMAC session secret persists across restarts so cookies survive redeploys.
function loadOrCreateSecret() {
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf8').trim()
  const secret = randomBytes(48).toString('hex')
  writeFileSync(SECRET_FILE, secret, { mode: 0o600 })
  return secret
}
const SECRET = loadOrCreateSecret()

function sign(user) {
  const mac = createHmac('sha256', SECRET).update(user).digest('hex')
  return `${user}.${mac}`
}
function verify(cookie) {
  if (!cookie || typeof cookie !== 'string') return null
  const [user, mac] = cookie.split('.')
  if (!user || !mac || !USERS[user]) return null
  const expect = createHmac('sha256', SECRET).update(user).digest('hex')
  return mac === expect ? user : null
}

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 'loopback')
app.use(express.json({ limit: '32kb' }))
app.use(cookieParser())

// ── static + login flow (before auth middleware) ─────────────────────
// The public plugins.json read must NOT be gated (landing/docs fetch it).
app.get('/admin/plugins.json', (req, res) => {
  res.type('application/json').send(readFileSync(STORE))
})

app.get('/admin/login', (req, res) => {
  if (verify(req.cookies[COOKIE_NAME])) return res.redirect('/admin/')
  res.sendFile(join(STATIC_DIR, 'login.html'))
})

app.post('/admin/api/login', async (req, res) => {
  const { user, pass } = req.body ?? {}
  const hash = USERS[user]
  if (!hash) return await sleepAnd(() => res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' }))
  const ok = await bcrypt.compare(String(pass ?? ''), hash)
  if (!ok) return await sleepAnd(() => res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' }))
  res.cookie(COOKIE_NAME, sign(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: COOKIE_MAX_AGE,
    path: '/admin',
  })
  res.json({ user })
})

app.post('/admin/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/admin' })
  res.json({ ok: true })
})

// ── ahv-web login flow (separate cookie scope, same USERS/HMAC) ──────
// Caddy proxies /ahv-auth/* here; Caddy's `forward_auth /ahv-auth/check`
// gates the rest of ahv.ahvclaw.com. The cookie path is /, unlike admin's
// /admin, so it applies to every path on the subdomain.
const AHV_COOKIE = 'ahv_web_sid'

app.get('/ahv-auth/login', (req, res) => {
  if (verify(req.cookies[AHV_COOKIE])) {
    // Already authed — bounce to the ahv-web root.
    return res.redirect('/')
  }
  res.sendFile(join(STATIC_DIR, 'ahv-web-login.html'))
})

// Accept both JSON (JS fetch) and form-encoded (native form / mobile
// fallback). Success → JSON for XHR clients, 302 for native form clients.
// Some mobile browsers download a JSON body when they get it as the
// direct response to a form POST, so the response shape must match how
// the client sent the request.
app.post('/ahv-auth/login', express.urlencoded({ extended: false }), async (req, res) => {
  const isJsonClient = req.is('json') !== false
  const { user, pass } = req.body ?? {}
  const hash = USERS[user]
  const fail = () => sleepAnd(() => {
    if (isJsonClient) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' })
    return res.redirect(303, '/ahv-auth/login?error=1')
  })
  if (!hash) return await fail()
  const ok = await bcrypt.compare(String(pass ?? ''), hash)
  if (!ok) return await fail()
  res.cookie(AHV_COOKIE, sign(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  })
  // Optional bounce target from ?next=. Only accept same-origin paths to
  // avoid open redirect. Default: /.
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//')
    ? req.query.next
    : '/'
  if (isJsonClient) return res.json({ user, redirect: next })
  // iOS Safari sometimes downloads the raw body of a 30x redirect after
  // a form POST (shows "document.txt" prompt instead of following the
  // Location header). An HTML page with meta-refresh + a JS
  // window.location assignment forces a real page render, and Safari's
  // heuristic sees text/html + a body and never triggers the download
  // path. The <a> link is the fallback if both meta and JS fail.
  const safe = String(next).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
  res.type('html').status(200).send(`<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"><title>Đang chuyển tới AHV Web…</title></head><body style="background:#0a0a0f;color:#e8e8f0;font-family:system-ui;text-align:center;padding-top:40vh"><p>Đăng nhập thành công.</p><p><a href="${safe}" style="color:#7dd3fc">Nếu không tự chuyển, bấm vào đây →</a></p><script>window.location.replace(${JSON.stringify(next)})</script></body></html>`)
})

app.post('/ahv-auth/logout', (req, res) => {
  res.clearCookie(AHV_COOKIE, { path: '/' })
  res.json({ ok: true })
})

// Cheap check for Caddy forward_auth. Returns 200 + X-User header when
// the cookie is valid, 401 otherwise. Body is empty on both paths since
// forward_auth doesn't read it.
app.get('/ahv-auth/check', (req, res) => {
  const user = verify(req.cookies[AHV_COOKIE])
  if (user) {
    res.setHeader('X-Ahv-User', user)
    return res.status(200).end()
  }
  res.status(401).end()
})

// Constant-ish delay on wrong-password to blunt brute force.
function sleepAnd(fn) {
  return new Promise(r => setTimeout(() => { fn(); r() }, 350))
}

// ── Public key-apply endpoint (no auth) ──────────────────────────────
// User cài `npm i -g @ahvclaw/cli` xong không có key → landing đề nghị
// vào /apply → gửi form → em nhận notification qua Telegram → em duyệt
// tay + gửi lại key cho user qua email/telegram họ để lại.

const applyRateLimit = new Map() // ip → last submit ts
function checkRateLimit(ip) {
  const now = Date.now()
  const last = applyRateLimit.get(ip) || 0
  if (now - last < APPLY_RATE_LIMIT_MS) {
    const wait = Math.ceil((APPLY_RATE_LIMIT_MS - (now - last)) / 60000)
    return `Bạn vừa gửi đơn cách đây không lâu, vui lòng đợi ${wait} phút.`
  }
  applyRateLimit.set(ip, now)
  return null
}

function readTgToken() {
  try {
    const env = readFileSync(TG_ENV_FILE, 'utf8')
    const m = env.match(/^TG_TOKEN=(.+)$/m)
    return m ? m[1].trim() : null
  } catch { return null }
}

async function notifyAdmin(applicationSummary) {
  const token = readTgToken()
  if (!token) return
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  const body = {
    chat_id: ADMIN_TG_CHAT_ID,
    text: applicationSummary,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    console.error('telegram notify failed:', e.message)
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]))
}

app.post('/admin/api/apply', async (req, res) => {
  // Domain sits behind Cloudflare, so req.ip is the CF edge node (varies
  // per request). Only CF-Connecting-IP is the real client IP for rate
  // limiting. Fallback to the usual chain for direct-hit / testing.
  const ip = req.headers['cf-connecting-ip']
    || req.ip
    || req.socket.remoteAddress
    || 'unknown'
  const rl = checkRateLimit(ip)
  if (rl) return res.status(429).json({ error: rl })

  const b = req.body ?? {}
  // Honeypot: real users can't see this field; bots fill everything.
  if (b.website) return res.status(200).json({ ok: true }) // silently absorb bot

  const name = String(b.name || '').trim().slice(0, 100)
  const email = String(b.email || '').trim().slice(0, 200)
  const telegram = String(b.telegram || '').trim().slice(0, 100)
  const useCase = String(b.useCase || '').trim().slice(0, 1000)

  const errors = []
  if (!name || name.length < 2) errors.push('Tên: bắt buộc, ít nhất 2 ký tự')
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Email không hợp lệ')
  if (!useCase || useCase.length < 10) errors.push('Bạn dùng AHV CLI làm gì? Mô tả ít nhất 10 ký tự')
  if (errors.length) return res.status(400).json({ errors })

  const app_ = {
    id: randomUUID(),
    name, email, telegram, useCase,
    ip,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
    status: 'pending',
    submittedAt: new Date().toISOString(),
  }

  // Append to store
  let data
  try {
    data = JSON.parse(readFileSync(APPLICATIONS_STORE, 'utf8'))
  } catch { data = { applications: [] } }
  data.applications.push(app_)
  writeFileSync(APPLICATIONS_STORE, JSON.stringify(data, null, 2))

  // Fire-and-forget Telegram notify (don't block response)
  notifyAdmin(
    `🔑 <b>Đơn xin AHV_API_KEY mới</b>\n\n`
    + `<b>Tên:</b> ${escapeHtml(name)}\n`
    + `<b>Email:</b> ${escapeHtml(email)}\n`
    + (telegram ? `<b>Telegram:</b> ${escapeHtml(telegram)}\n` : '')
    + `<b>Use case:</b>\n<i>${escapeHtml(useCase.slice(0, 500))}</i>\n\n`
    + `<b>IP:</b> <code>${escapeHtml(ip)}</code>\n`
    + `<b>App ID:</b> <code>${app_.id.slice(0, 8)}</code>\n\n`
    + `Xem full: https://ahvclaw.com/admin/#applications`
  )

  res.status(201).json({ ok: true, id: app_.id })
})

// Serve the apply form as a public page (no auth needed).
app.get('/apply', (req, res) => res.sendFile(join(STATIC_DIR, 'apply.html')))
app.get('/apply/', (req, res) => res.sendFile(join(STATIC_DIR, 'apply.html')))

// ── auth gate: everything below requires a valid cookie ──────────────
app.use('/admin', (req, res, next) => {
  const user = verify(req.cookies[COOKIE_NAME])
  if (user) { req.user = user; return next() }
  // Browsers asking for HTML → redirect. XHR/API → 401 JSON.
  const accept = req.headers.accept || ''
  if (accept.includes('text/html') && req.method === 'GET') {
    return res.redirect('/admin/login')
  }
  res.status(401).json({ error: 'unauthorized' })
})

// ── plugin registry API ──────────────────────────────────────────────
app.get('/admin/api/me', (req, res) => res.json({ user: req.user }))

app.get('/admin/api/plugins', (req, res) => res.json(load()))

app.post('/admin/api/plugins', (req, res) => {
  const b = req.body ?? {}
  const errors = validate(b)
  if (errors.length) return res.status(400).json({ errors })
  const data = load()
  if (data.plugins.some(p => p.name === b.name)) {
    return res.status(409).json({ errors: [`plugin "${b.name}" đã tồn tại`] })
  }
  const plugin = {
    id: randomUUID(),
    category: String(b.category || 'other').slice(0, 32),
    name: String(b.name).slice(0, 128),
    github: String(b.github || '').slice(0, 256),
    description: String(b.description || '').slice(0, 500),
    cordisId: String(b.cordisId || b.name.split('/').pop()).slice(0, 64),
    enabled: b.enabled !== false,
    source: String(b.source || 'npm').slice(0, 16),
  }
  data.plugins.push(plugin)
  save(data)
  res.status(201).json(plugin)
})

app.put('/admin/api/plugins/:id', (req, res) => {
  const data = load()
  const idx = data.plugins.findIndex(p => p.id === req.params.id)
  if (idx < 0) return res.status(404).json({ errors: ['not found'] })
  const b = req.body ?? {}
  const errors = validate({ ...data.plugins[idx], ...b })
  if (errors.length) return res.status(400).json({ errors })
  data.plugins[idx] = { ...data.plugins[idx], ...b, id: data.plugins[idx].id }
  save(data)
  res.json(data.plugins[idx])
})

app.delete('/admin/api/plugins/:id', (req, res) => {
  const data = load()
  const before = data.plugins.length
  data.plugins = data.plugins.filter(p => p.id !== req.params.id)
  if (data.plugins.length === before) return res.status(404).json({ errors: ['not found'] })
  save(data)
  res.status(204).end()
})

app.get('/admin/api/export', (req, res) => {
  const enabled = load().plugins.filter(p => p.enabled)
  res.json({
    cordisPatch: renderCordisPatch(enabled),
    packageDeps: renderPackageJsonDeps(enabled),
    count: enabled.length,
  })
})

// Application review (auth).
app.get('/admin/api/applications', (req, res) => {
  try {
    const data = JSON.parse(readFileSync(APPLICATIONS_STORE, 'utf8'))
    // Newest first
    data.applications.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''))
    res.json(data)
  } catch {
    res.json({ applications: [] })
  }
})

app.put('/admin/api/applications/:id', (req, res) => {
  let data
  try { data = JSON.parse(readFileSync(APPLICATIONS_STORE, 'utf8')) }
  catch { return res.status(404).json({ error: 'not found' }) }
  const idx = data.applications.findIndex(a => a.id === req.params.id)
  if (idx < 0) return res.status(404).json({ error: 'not found' })
  const b = req.body ?? {}
  if (b.status && !['pending', 'approved', 'rejected'].includes(b.status)) {
    return res.status(400).json({ error: 'invalid status' })
  }
  if (b.status) data.applications[idx].status = b.status
  if (typeof b.note === 'string') data.applications[idx].note = b.note.slice(0, 500)
  data.applications[idx].updatedAt = new Date().toISOString()
  writeFileSync(APPLICATIONS_STORE, JSON.stringify(data, null, 2))
  res.json(data.applications[idx])
})

// ── protected static UI (index.html) ─────────────────────────────────
app.get(['/admin', '/admin/'], (req, res) => res.sendFile(join(STATIC_DIR, 'index.html')))
app.use('/admin', express.static(STATIC_DIR, { extensions: ['html'], index: false }))

// ── helpers ──────────────────────────────────────────────────────────
function load() { return JSON.parse(readFileSync(STORE, 'utf8')) }
function save(data) {
  data.updatedAt = new Date().toISOString()
  writeFileSync(STORE, JSON.stringify(data, null, 2))
}

function validate(p) {
  const e = []
  if (!p.name || typeof p.name !== 'string') e.push('name bắt buộc')
  if (p.name && p.name.length > 128) e.push('name quá dài')
  if (p.github && !/^https?:\/\/(github\.com|gitlab\.com)\//.test(p.github)) e.push('github url không hợp lệ')
  if (p.source && !['workspace', 'npm', 'git'].includes(p.source)) e.push('source phải là workspace|npm|git')
  if (typeof p.enabled !== 'undefined' && typeof p.enabled !== 'boolean') e.push('enabled phải là boolean')
  // Version fields là advisory (auto-populate bởi refresh-versions), không
  // strict-validate; user không edit tay qua form thường.
  return e
}

// ── Version tracking (pinned vs latest, stale detection) ───────────────
// Refresh script quét từng plugin, lookup latest theo source:
//   npm    → GET registry.npmjs.org/{name}/latest → .version
//   git    → GET api.github.com/repos/{owner}/{repo}/releases/latest → .tag_name
//   workspace → local git commit ngắn (AHV fork state); latest = pinned
// Pinned version đọc từ AHV bundle package.json dependencies field.
const AHV_FORK = process.env.AHV_FORK ?? '/home/claudeproxy/.ahv/src'
const AHV_BUNDLE_PKG = `${AHV_FORK}/packages/bundle/ahv/package.json`

async function fetchNpmLatest(pkgName) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName).replace('%40', '@')}/latest`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = await res.json()
    return { ok: true, version: body.version }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message }
  }
}

async function fetchGithubReleaseLatest(githubUrl) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/.*)?(?:\.git)?$/.exec(githubUrl)
  if (!m) return { ok: false, error: 'không parse được github url' }
  const [, owner, repo] = m
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'ahv-admin' } })
    clearTimeout(timer)
    if (res.status === 404) return { ok: true, version: null, note: 'không có release trên github (repo có thể chỉ dùng tag)' }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = await res.json()
    return { ok: true, version: body.tag_name }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message }
  }
}

function readPinnedVersion(pluginName) {
  try {
    const pkg = JSON.parse(readFileSync(AHV_BUNDLE_PKG, 'utf8'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const spec = deps[pluginName]
    if (!spec) return null
    if (spec.startsWith('workspace:')) return 'workspace'
    if (spec.startsWith('git+')) return `git+${spec.slice(4).split('#').pop() ?? 'HEAD'}`
    // npm-style ^1.2.3 / ~1.2.3 / 1.2.3 / latest
    return spec.replace(/^[~^>=<]+/, '').split('||')[0].trim()
  } catch { return null }
}

async function refreshVersions() {
  const data = load()
  const results = []
  for (const p of data.plugins) {
    const pinned = readPinnedVersion(p.name) ?? p.version_pinned ?? null
    let latest = null
    let error = null
    if (p.source === 'npm') {
      const r = await fetchNpmLatest(p.name)
      latest = r.ok ? r.version : null
      error = r.ok ? null : r.error
    } else if (p.source === 'git' && p.github) {
      const r = await fetchGithubReleaseLatest(p.github)
      latest = r.ok ? r.version : null
      error = r.ok ? null : r.error
    } else if (p.source === 'workspace') {
      latest = 'workspace'  // Local — luôn "latest" theo AHV fork HEAD
    }
    const stale = pinned !== null && latest !== null && latest !== 'workspace' && pinned !== 'workspace' && pinned !== latest
    p.version_pinned = pinned
    p.version_latest = latest
    p.version_checked_at = new Date().toISOString()
    p.version_stale = stale
    p.version_error = error
    results.push({ name: p.name, pinned, latest, stale, error })
  }
  data.updatedAt = new Date().toISOString()
  save(data)
  return results
}

app.post('/admin/api/plugins/refresh-versions', async (req, res) => {
  if (!verify(req.cookies?.[COOKIE_NAME])) return res.status(401).json({ error: 'not logged in' })
  try {
    const results = await refreshVersions()
    res.json({
      updated_at: new Date().toISOString(),
      count: results.length,
      stale_count: results.filter(r => r.stale).length,
      results,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Auto-refresh mỗi 6 giờ, chạy 1 lần khi boot (delay 30s để server sẵn sàng).
setTimeout(() => { void refreshVersions().catch(err => console.error('initial version refresh failed:', err)) }, 30_000)
setInterval(() => { void refreshVersions().catch(err => console.error('scheduled version refresh failed:', err)) }, 6 * 60 * 60 * 1000)

function renderCordisPatch(plugins) {
  const rows = plugins.map(p => {
    const id = p.cordisId || p.name.split('/').pop()
    const lines = [`    - id: ${id}`, `      name: '${p.name}'`]
    if (!p.enabled) lines.push(`      disabled: true`)
    return lines.join('\n')
  })
  return `# Auto-generated từ /admin. Paste block dưới vào\n# packages/bundle/ahv/cordis.patch.yml dưới "- insert:" list.\n\n${rows.join('\n\n')}\n`
}

function renderPackageJsonDeps(plugins) {
  const deps = {}
  for (const p of plugins) {
    if (p.source === 'workspace') deps[p.name] = 'workspace:^'
    else if (p.source === 'npm') deps[p.name] = 'latest'
    else if (p.source === 'git') deps[p.name] = `git+${p.github}`
  }
  return JSON.stringify(deps, null, 2)
}

// Bootstrap store on first boot (same seed as before).
function bootstrap() {
  if (existsSync(STORE)) return
  mkdirSync(dirname(STORE), { recursive: true })
  const seed = [
    { id: randomUUID(), category: 'terminal', name: '@deepseek-ai/dsh-terminal',
      github: 'https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/terminal/terminal',
      description: 'Persistent PTY registry — session ids, backend registry.',
      cordisId: 'terminal-registry', enabled: true, source: 'workspace' },
    { id: randomUUID(), category: 'terminal', name: '@deepseek-ai/dsh-terminal-bash',
      github: 'https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/terminal/terminal-bash',
      description: 'Bash backend cho persistent terminal.',
      cordisId: 'terminal-bash', enabled: true, source: 'workspace' },
    { id: randomUUID(), category: 'terminal', name: '@deepseek-ai/dsh-tool-terminal',
      github: 'https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/terminal/tool-terminal',
      description: '6 model-facing tool over ctx.terminals.',
      cordisId: 'tool-terminal', enabled: true, source: 'workspace' },
    { id: randomUUID(), category: 'self-modify', name: '@deepseek-ai/dsh-cordis-host-runner',
      github: 'https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/extensions/cordis-host-runner',
      description: 'vm sandbox + dynamic-package registry cho self-modification.',
      cordisId: 'cordis-host-runner', enabled: true, source: 'workspace' },
    { id: randomUUID(), category: 'self-modify', name: '@deepseek-ai/dsh-tool-cordis',
      github: 'https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/extensions/tool-cordis',
      description: '5 tool: cordis_inspect/define/run/stop/undefine.',
      cordisId: 'tool-cordis', enabled: true, source: 'workspace' },
    { id: randomUUID(), category: 'market', name: 'dshmarket',
      github: 'https://github.com/dsh-market/dsh-market',
      description: 'Plugin Market UI — browse + one-click install 1.5k+ community plugin.',
      cordisId: 'dsh-market', enabled: true, source: 'npm' },
  ]
  writeFileSync(STORE, JSON.stringify({ plugins: seed, updatedAt: new Date().toISOString() }, null, 2))
}
bootstrap()

app.listen(PORT, HOST, () => {
  console.log(`ahv-admin listening on http://${HOST}:${PORT}`)
})
