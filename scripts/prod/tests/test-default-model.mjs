// The user's chosen default model must survive the move to dsh 0.2.
//
// 0.1 applied $DSH_HOME/settings.yaml (written by the web's model picker) to
// every run, the Telegram bot's included. 0.2 renames it to settings.yaml.imported,
// does not carry agent-default-model over, and the AHV patch layer would
// override a profile row anyway — on #20 the bot silently went from the chosen
// Grok 4.6 (xhigh) to ahv-qwen38 (the router default before #976).
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const m = await import(new URL('../ahv-plugin-grants.mjs', import.meta.url).href)
let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++ }
}
// Exactly as #20 had it (settings.yaml.imported after 0.2's first start).
const LEGACY = 'pet:\n  visible: false\n  petId: whale-girl\nagent-default-model:\n  provider: grok\n  model: grok-4.6\n  reasoningEffort: xhigh\nui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n'
// As 0.2's settings editor writes a row.
const WEB_ROW = '# placeholder\n- insert:\n    - id: web-ui-skin-center\n      name: \'@linxin666/dsh-client-ui-skin-center\'\n- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: claude\n    model: "claude-sonnet-5-5"\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n'
function home(files) {
  const h = mkdtempSync(join(tmpdir(), 'defmodel-'))
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(h, rel, '..'), { recursive: true }); writeFileSync(join(h, rel), text) }
  return h
}

check('reads the 0.1 settings section, reasoning effort included', () => {
  assert.deepEqual(m.defaultModelFromLegacySettings(LEGACY), { provider: 'grok', model: 'grok-4.6', reasoningEffort: 'xhigh' })
})
check('reads a 0.2 profile row, quotes and name line tolerated, stops at the next row', () => {
  assert.deepEqual(m.defaultModelFromPatch(WEB_ROW), { provider: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: '' })
})
check('a profile without the row yields nothing', () => {
  assert.equal(m.defaultModelFromPatch('- id: browser\n  config:\n    autoInstall: false\n'), undefined)
})
check('values outside the safe set are refused (they reach the shell)', () => {
  assert.equal(m.defaultModelFromLegacySettings('agent-default-model:\n  provider: "a b"\n  model: x\n'), undefined)
  assert.equal(m.defaultModelFromLegacySettings("agent-default-model:\n  provider: $(id)\n  model: x\n"), undefined)
})
check('precedence: web row > headless row > settings.yaml > settings.yaml.imported > AHV default', () => {
  assert.equal(m.chosenDefaultModel(home({ 'settings.yaml.imported': LEGACY, 'profiles/web/cordis.patch.yml': WEB_ROW })).provider, 'claude')
  assert.equal(m.chosenDefaultModel(home({ 'settings.yaml.imported': LEGACY })).model, 'grok-4.6')
  assert.equal(m.chosenDefaultModel(home({ 'settings.yaml': LEGACY.replace('grok-4.6', 'grok-4.7') , 'settings.yaml.imported': LEGACY })).model, 'grok-4.7')
  assert.deepEqual(m.chosenDefaultModel(home({})), { ...m.AHV_DEFAULT_MODEL })
})

// #976: ahv-qwen38 lived only behind the old router; AHV AI answers it with
// model_not_found, so every saved choice of it must come out as AHV-Holding.
check('the AHV default is AHV-Holding', () => {
  assert.deepEqual({ ...m.AHV_DEFAULT_MODEL }, { provider: 'ahv-router', model: 'AHV-Holding', reasoningEffort: '' })
})
check('a saved ahv-qwen38 choice (settings.yaml or web row) becomes AHV-Holding', () => {
  const legacyQwen = 'agent-default-model:\n  provider: ahv-router\n  model: ahv-qwen38\n  reasoningEffort: high\n'
  const webQwen = '- id: agent-default-model\n  config:\n    provider: ahv-router\n    model: "ahv-qwen38"\n'
  assert.deepEqual(m.defaultModelFromLegacySettings(legacyQwen), { ...m.AHV_DEFAULT_MODEL, reasoningEffort: 'high' })
  assert.deepEqual(m.defaultModelFromPatch(webQwen), { ...m.AHV_DEFAULT_MODEL })
  assert.deepEqual(m.chosenDefaultModel(home({ 'settings.yaml.imported': legacyQwen })), { ...m.AHV_DEFAULT_MODEL, reasoningEffort: 'high' })
  assert.deepEqual(m.chosenDefaultModel(home({ 'profiles/web/cordis.patch.yml': webQwen, 'settings.yaml': LEGACY })), { ...m.AHV_DEFAULT_MODEL })
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
