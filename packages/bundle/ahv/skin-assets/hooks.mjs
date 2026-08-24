// AHV skin hooks — text substitution + favicon override.
// Runs client-side after skin activation, before app fully mounts.
// See @linxin666/dsh-client-ui-skin-center contracts/README for API.
//
// Zero server-side patching; if the loader can't hand us a runtime, we
// fail closed (skin stylesheet still applies, text rebrand skipped).

// Longest-first so composite phrases match before their prefix.
// Sensitive to word order — "DSH Local Build" must match before bare "DSH".
const LABEL_REPLACEMENTS = new Map([
  ['Into the Unknown', 'Đây là phiên bản Web của AHV Harness'],
  ['DSH Local Build', 'AHV Harness'],
  ['DSH local build', 'AHV Harness'],
  ['DeepSeek Harness', 'AHV Harness'],
  ['DSH Web', 'AHV Web'],
  ['dsh-web-app', 'ahv-web'],
  ['dsh web', 'ahv web'],
  ['DSH', 'AHV Harness'],
  ['dsh', 'ahv'],
])

/**
 * MutationObserver keeps rebrand fresh across dynamic renders.
 * Only rewrites text nodes (never attributes, never inside code/pre).
 */
function installTextRebrand() {
  const REJECT_PARENTS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT'])

  function rewriteTextNode(node) {
    const parent = node.parentElement
    if (!parent || REJECT_PARENTS.has(parent.tagName)) return
    let text = node.nodeValue
    let changed = false
    for (const [from, to] of LABEL_REPLACEMENTS) {
      if (text.includes(from)) {
        text = text.split(from).join(to)
        changed = true
      }
    }
    if (changed) node.nodeValue = text
  }

  function walk(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walker.nextNode())) rewriteTextNode(n)
  }

  walk(document.body)

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) rewriteTextNode(node)
        else if (node.nodeType === Node.ELEMENT_NODE) walk(node)
      }
      if (r.type === 'characterData' && r.target.nodeType === Node.TEXT_NODE) {
        rewriteTextNode(r.target)
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}

/**
 * The AHV mark: the monogram A drawn as one stroke over a dark tile, with the
 * crossbar broken into a link and the right foot curling into a claw — the
 * harness and the AHVclaw name, and what keeps it from reading as a generic
 * letter tile.
 *
 * Built from strokes rather than a text glyph so it stays identical across
 * platforms and stays legible at favicon size, where the previous emoji-based
 * icon depended on whatever emoji font the OS happened to ship.
 */
function ahvMarkSvg(idSuffix = '') {
  const g = `ahvG${idSuffix}`
  const tile = `ahvT${idSuffix}`
  const glow = `ahvW${idSuffix}`
  // Same geometry as the console, the landing page and both favicons. It was
  // drawn here at a smaller viewBox without the tile gradient or the corner
  // glow, which read as a different logo beside them.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%" role="img" aria-label="AHV Harness">
    <defs>
      <linearGradient id="${g}" x1="8" y1="56" x2="56" y2="8" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#5eead4"/>
        <stop offset="0.45" stop-color="#7dd3fc"/>
        <stop offset="1" stop-color="#a78bfa"/>
      </linearGradient>
      <linearGradient id="${tile}" x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#131c33"/>
        <stop offset="1" stop-color="#080c17"/>
      </linearGradient>
      <radialGradient id="${glow}" cx="0.28" cy="0.2" r="0.85">
        <stop offset="0" stop-color="#5eead4" stop-opacity="0.30"/>
        <stop offset="1" stop-color="#5eead4" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="64" height="64" rx="17" fill="url(#${tile})"/>
    <rect width="64" height="64" rx="17" fill="url(#${glow})"/>
    <rect x="1.3" y="1.3" width="61.4" height="61.4" rx="15.9" fill="none"
          stroke="url(#${g})" stroke-opacity="0.55" stroke-width="1.6"/>
    <path d="M14.6 50.6 32 12.8l14.6 31.6c1.9 4.1.5 6.9-3.7 6.9" fill="none"
          stroke="url(#${g})" stroke-width="6.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M23.6 38.4h5.6" stroke="url(#${g})" stroke-width="5.8" stroke-linecap="round"/>
    <path d="M35.6 38.4h5.6" stroke="url(#${g})" stroke-width="5.8" stroke-linecap="round"/>
  </svg>`
}

const AHV_MARK_SVG = ahvMarkSvg()

/**
 * Put our mark in the slots the app publishes for it.
 *
 * These are the app's own extension points (`sidebar.brand.mark`,
 * `conversation.hero.brand.mark`), so an upstream release that restyles the
 * shell keeps rendering our logo — nothing here patches dsh source, which is
 * what makes the branding survive updates.
 *
 * The observer matters because the shell re-renders these nodes on navigation;
 * a one-shot write is stomped the first time the view changes.
 */
function installBrandMark() {
  const SLOTS = ['sidebar.brand.mark', 'conversation.hero.brand.mark']

  function paint() {
    for (const slot of SLOTS) {
      for (const host of document.querySelectorAll(`[data-slot="${slot}"]`)) {
        if (host.dataset.ahvMark === '1') continue
        host.dataset.ahvMark = '1'
        host.innerHTML = AHV_MARK_SVG
        host.style.display = 'inline-flex'
        host.style.alignItems = 'center'
        host.style.width = host.style.width || '22px'
        host.style.height = host.style.height || '22px'
      }
    }
  }

  paint()
  const observer = new MutationObserver(paint)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => observer.disconnect()
}

/**
 * Point the favicon at the same mark as the sidebar.
 *
 * The URI is built by encoding the raw SVG: writing `%23` by hand and then
 * running encodeURIComponent over it yields `%2523`, an invalid IRI, so the
 * gradient reference silently failed and the tile never painted.
 */
function installFavicon() {
  const url = 'data:image/svg+xml,' + encodeURIComponent(ahvMarkSvg('Fav'))

  document.querySelectorAll('link[rel~="icon"]').forEach(l => l.remove())
  const link = document.createElement('link')
  link.rel = 'icon'
  link.type = 'image/svg+xml'
  link.href = url
  document.head.appendChild(link)
}

/**
 * Force tab title to AHV — override every write. The app rewrites title on
 * session change so a one-shot assignment gets stomped; a defineProperty on
 * document.title routes every future setter through our sanitizer instead.
 */
function installTitleGuard() {
  const AHV_TITLE = 'AHV Harness'

  function sanitize(input) {
    if (!input) return AHV_TITLE
    let text = String(input)
    for (const [from, to] of LABEL_REPLACEMENTS) {
      if (text.includes(from)) text = text.split(from).join(to)
    }
    // Strip stray "Local Build" or version suffix appended by dsh.
    text = text.replace(/\s*(Local Build|local build|Dev Build|dev build)\s*/gi, ' ').trim()
    return text || AHV_TITLE
  }

  const proto = Object.getPrototypeOf(document)
  const desc = Object.getOwnPropertyDescriptor(proto, 'title')
    ?? Object.getOwnPropertyDescriptor(document, 'title')
  if (!desc?.set || !desc?.get) {
    document.title = AHV_TITLE
    return () => {}
  }

  Object.defineProperty(document, 'title', {
    configurable: true,
    get() { return desc.get.call(this) },
    set(v) { desc.set.call(this, sanitize(v)) },
  })
  document.title = sanitize(document.title)

  return () => {
    Object.defineProperty(document, 'title', {
      configurable: true, get: desc.get, set: desc.set,
    })
  }
}

/**
 * Fallback sweep — re-walk the DOM every 500ms for the first 10 seconds
 * after activate. Catches late React mounts that observer misses.
 */
function installSweepFallback() {
  const REJECT_PARENTS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT'])
  const sweep = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walker.nextNode())) {
      const parent = n.parentElement
      if (!parent || REJECT_PARENTS.has(parent.tagName)) continue
      let text = n.nodeValue, changed = false
      for (const [from, to] of LABEL_REPLACEMENTS) {
        if (text.includes(from)) { text = text.split(from).join(to); changed = true }
      }
      if (changed) n.nodeValue = text
    }
  }
  const iv = setInterval(sweep, 500)
  const to = setTimeout(() => clearInterval(iv), 10000)
  return () => { clearInterval(iv); clearTimeout(to) }
}

/**
 * Strip inline `<think>...</think>` reasoning blocks from assistant messages.
 * AHV Router's DeepSeek combos emit reasoning inline in the content stream
 * instead of on the OpenAI `reasoning_content` field — dsh's Think row
 * expects the structured field, so the raw <think> tags land in the visible
 * markdown. This observer regex-strips the whole block from chat text.
 *
 * Runs continuously (not on a timer) so streaming deltas that arrive after
 * the initial sweep are also cleaned. Only walks messages under known chat
 * containers to avoid clobbering user-typed <think> code samples in the
 * composer or in markdown code blocks (excluded via REJECT_PARENTS).
 */
function installThinkStripper() {
  const REJECT_PARENTS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT'])
  // Match a complete <think>…</think> across newlines.
  const FULL = /<think>[\s\S]*?<\/think>\s*/gi
  // Live streaming tail: opener seen, closer not yet.
  const OPEN_ONLY = /<think>[\s\S]*/i
  // Closer only — HTML parser silently drops <think> as an unknown tag, so
  // the DOM text node lands with the closer but no opener. In practice the
  // whole prefix up to </think> is reasoning; strip it.
  const CLOSE_ONLY = /^[\s\S]*?<\/think>\s*/i

  function strip(text) {
    const hasOpen = text.includes('<think>')
    const hasClose = text.includes('</think>')
    if (hasOpen && hasClose) return text.replace(FULL, '')
    if (hasClose) return text.replace(CLOSE_ONLY, '')
    if (hasOpen) return text.replace(OPEN_ONLY, '')
    return text
  }

  // Boundary check — walk up ancestors until this element is a message-level
  // container. Stops the sibling-hiding sweep from cascading outside the one
  // chat bubble that owns the think block.
  function isMessageRoot(el) {
    if (!el || !el.matches) return false
    return el.matches('article, li, [role="listitem"], [role="article"], [class*="message"i], [class*="Message"], [class*="turn"i], [data-turn], [data-message-id]')
  }

  function scrub(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const closerNodes = []
    let n
    while ((n = walker.nextNode())) {
      const parent = n.parentElement
      if (!parent || REJECT_PARENTS.has(parent.tagName)) continue
      const t = n.nodeValue
      if (!t) continue
      if (t.includes('</think>')) closerNodes.push(n)
      else if (t.includes('<think>')) {
        // Complete pair inline in one text node — regex strip
        const cleaned = strip(t)
        if (cleaned !== t) n.nodeValue = cleaned
      }
    }

    // For every </think> closer: strip the text node itself + hide every
    // preceding sibling element up to the enclosing message boundary. This
    // covers the common case where HTML parser dropped the <think> opener
    // as an unknown tag and the reasoning content is spread across multiple
    // paragraph/div nodes preceding the closer.
    for (const closer of closerNodes) {
      const t = closer.nodeValue
      const idx = t.indexOf('</think>')
      closer.nodeValue = t.slice(idx + '</think>'.length).trim()

      let current = closer.parentElement
      while (current) {
        // Hide every previous sibling within this ancestor's children.
        let sib = current.previousElementSibling
        while (sib) {
          sib.style.display = 'none'
          sib.dataset.ahvHidden = 'think'
          sib = sib.previousElementSibling
        }
        // If this element is itself now empty (only whitespace after strip),
        // hide it too. Otherwise it holds the final answer prefix — keep.
        if (!closer.nodeValue && current !== closer.parentElement) {
          current.style.display = 'none'
          current.dataset.ahvHidden = 'think'
        }
        const parent = current.parentElement
        if (!parent || parent === document.body) break
        if (isMessageRoot(parent)) break
        current = parent
      }
    }
  }

  scrub(document.body)

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const parent = node.parentElement
          if (parent && !REJECT_PARENTS.has(parent.tagName)) {
            const t = node.nodeValue
            if (t && (t.includes('<think>') || t.includes('</think>'))) {
              node.nodeValue = strip(t)
            }
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          scrub(node)
        }
      }
      if (r.type === 'characterData' && r.target.nodeType === Node.TEXT_NODE) {
        const t = r.target.nodeValue
        const parent = r.target.parentElement
        if (t && parent && !REJECT_PARENTS.has(parent.tagName)
          && (t.includes('<think>') || t.includes('</think>'))) {
          r.target.nodeValue = strip(t)
        }
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}

/** Skin-center calls this after activation. */
export function activate() {
  installFavicon()
  const disposeMark = installBrandMark()
  const disposeText = installTextRebrand()
  const disposeTitle = installTitleGuard()
  const disposeSweep = installSweepFallback()
  const disposeThink = installThinkStripper()
  return () => {
    disposeMark()
    disposeText()
    disposeTitle()
    disposeSweep()
    disposeThink()
    // Favicon left in place — cheap, no leak; skin swap will re-run.
  }
}

/**
 * skin-center contract "x-org.linxin666.skin-center/v1alpha1": hooks.mjs must
 * default-export this factory. The runtime calls it once per activation, then
 * apply(); loading the module must not execute anything. The teardown lives in
 * the closure rather than at module level because every skin switch is a new
 * activation identity and dispose may run 0, 1 or N times.
 */
export default function defineSkinHooks() {
  let teardown = null
  return {
    apply() {
      if (teardown) return
      teardown = activate()
    },
    dispose() {
      if (!teardown) return
      const fn = teardown
      teardown = null
      fn()
    },
  }
}
