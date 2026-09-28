// The release must vouch for exactly the plugin versions it ships.
//
// dsh 0.2 disables a plugin whose dsh peer range misses the running version
// unless the profile's compatibility.json grants that exact package@version for
// that exact dsh version. Too little and the bot silently loses its
// subscriptions and browser tools; too much and a user's own plugin would be
// waved through without anyone having run it.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const { grantShippedPlugins, shippedPluginKeys } = await import(new URL('../ahv-plugin-grants.mjs', import.meta.url).href)

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++ }
}
function pkg(dir, name, version, extra = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, ...extra }))
}
function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'grants-'))
  const fork = join(root, 'src'); const home = join(root, 'dsh')
  pkg(join(fork, 'apps/cli'), '@deepseek-ai/dsh', '0.2.0-rc.1')
  pkg(join(fork, 'packages/bundle/ahv'), '@ahvclaw/dsh-bundle-ahv', '0.1.0', { dependencies: {
    'dsh-plugin-subscriptions': '^0.9.6', '@anweat/dsh-browser': '^0.1.15',
    '@deepseek-ai/dsh-base': 'workspace:^', 'not-installed': '^1.0.0',
  } })
  pkg(join(fork, 'packages/bundle/ahv/node_modules/dsh-plugin-subscriptions'), 'dsh-plugin-subscriptions', '0.9.6')
  pkg(join(fork, 'packages/bundle/ahv/node_modules/@anweat/dsh-browser'), '@anweat/dsh-browser', '0.1.15')
  // pnpm links workspace packages into node_modules too; they ship with dsh itself.
  pkg(join(fork, 'packages/bundle/ahv/node_modules/@deepseek-ai/dsh-base'), '@deepseek-ai/dsh-base', '0.2.0-rc.1')
  return { fork, home, file: p => join(home, 'profiles', p, 'compatibility.json') }
}
const read = f => JSON.parse(readFileSync(f, 'utf8'))

check('grants the installed versions of the bundle plugins for this dsh version', () => {
  const t = scaffold()
  assert.equal(grantShippedPlugins(t.fork, t.home, 'headless').status, 'written')
  assert.deepEqual(read(t.file('headless')), {
    '@anweat/dsh-browser@0.1.15': ['0.2.0-rc.1'],
    'dsh-plugin-subscriptions@0.9.6': ['0.2.0-rc.1'],
  })
})
check('never grants workspace packages or declared-but-missing plugins', () => {
  const t = scaffold()
  const keys = shippedPluginKeys(t.fork, join(t.home, 'profiles/headless'))
  assert.ok(!keys.some(k => k.startsWith('@deepseek-ai/') || k.startsWith('not-installed')), keys.join(','))
})
check('keeps grants the user already made and is idempotent', () => {
  const t = scaffold()
  mkdirSync(join(t.home, 'profiles/headless'), { recursive: true })
  writeFileSync(t.file('headless'), JSON.stringify({ 'mine@1.0.0': ['0.2.0-rc.1'], 'dsh-plugin-subscriptions@0.9.6': ['0.1.9'] }))
  grantShippedPlugins(t.fork, t.home, 'headless')
  assert.equal(grantShippedPlugins(t.fork, t.home, 'headless').status, 'unchanged')
  const got = read(t.file('headless'))
  assert.deepEqual(got['mine@1.0.0'], ['0.2.0-rc.1'])
  assert.deepEqual(got['dsh-plugin-subscriptions@0.9.6'], ['0.1.9', '0.2.0-rc.1'])
})
check('a user plugin installed in the profile is not granted', () => {
  const t = scaffold()
  pkg(join(t.home, 'profiles/web/node_modules/some-user-plugin'), 'some-user-plugin', '1.2.3')
  grantShippedPlugins(t.fork, t.home, 'web')
  assert.ok(!Object.keys(read(t.file('web'))).some(k => k.startsWith('some-user-plugin')))
})
check('the AHV skin plugin installed in the web profile is granted', () => {
  const t = scaffold()
  pkg(join(t.home, 'profiles/web/node_modules/@linxin666/dsh-client-ui-skin-center'), '@linxin666/dsh-client-ui-skin-center', '0.2.7')
  grantShippedPlugins(t.fork, t.home, 'web')
  assert.deepEqual(read(t.file('web'))['@linxin666/dsh-client-ui-skin-center@0.2.7'], ['0.2.0-rc.1'])
})
check('an unparsable compatibility file is left untouched', () => {
  const t = scaffold()
  mkdirSync(join(t.home, 'profiles/headless'), { recursive: true })
  writeFileSync(t.file('headless'), '{ broken')
  assert.equal(grantShippedPlugins(t.fork, t.home, 'headless').status, 'skipped')
  assert.equal(readFileSync(t.file('headless'), 'utf8'), '{ broken')
})
check('a fresh home gets a profile dir holding only the grant (dsh initialises the rest)', () => {
  const t = scaffold()
  grantShippedPlugins(t.fork, t.home, 'headless')
  assert.ok(existsSync(t.file('headless')))
  assert.ok(!existsSync(join(t.home, 'profiles/headless/package.json')))
})

check('runs as a command when reached through a symlinked tree (how ~/.ahv/src is laid out)', () => {
  const t = scaffold()
  const real = dirname(dirname(fileURLToPath(import.meta.url)))
  const link = join(mkdtempSync(join(tmpdir(), 'grants-link-')), 'prod')
  symlinkSync(real, link)
  execFileSync(process.execPath, [join(link, 'ahv-plugin-grants.mjs'), t.fork, t.home, 'headless'])
  assert.ok(existsSync(t.file('headless')), 'no compatibility.json written')
})

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
