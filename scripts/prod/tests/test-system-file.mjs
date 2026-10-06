#!/usr/bin/env node
// `ahv run --system-file F` carries the bot's per-call instructions into dsh as
// AHV_BOT_SYSTEM_SUFFIX, which the bot patch hands to bot-runner as
// systemSuffix; bot-runner appends it after the AHV persona without `{{…}}`
// interpolation. A home-layer suffix is overwritten by the bundle (#724 spec
// §2), so the flag is the only per-call path. Without the flag the variable is
// dropped, so a job spawned from a bot turn does not inherit it.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { prepareBotEnv } from '../ahv-bot.mjs'

const dir = mkdtempSync(join(tmpdir(), 'sysfile-'))
const f = join(dir, 's.md'); const text = 'Lời dặn "x" \\ y\ndòng 2 XRAY-5151'
writeFileSync(f, text)
{ const r = prepareBotEnv(['--system-file', f, '-p', 'hi'], {})
  assert.deepEqual(r.argv, ['-p', 'hi']); assert.equal(r.env.AHV_BOT_SYSTEM_SUFFIX, text) }
{ const r = prepareBotEnv(['-p', 'hi'], { AHV_BOT_SYSTEM_SUFFIX: 'thừa kế' })
  assert.equal('AHV_BOT_SYSTEM_SUFFIX' in r.env, false) }
{ const big = join(dir, 'big.md'); writeFileSync(big, 'x'.repeat(65 * 1024))
  assert.throws(() => prepareBotEnv(['--system-file', big], {}), /system_file_invalid/) }
// The core personaSuffix interpolates `{{…}}`, so the text goes to bot-runner instead.
{ const y = readFileSync(new URL('../../../packages/bundle/ahv/cordis.patch.yml', import.meta.url), 'utf8')
  const block = y.split('- id: system-prompt')[1].split('\n- id:')[0]
  assert.match(block, /personaPrefix:/); assert.doesNotMatch(y, /AHV_BOT_SYSTEM_SUFFIX/)
  const bot = readFileSync(new URL('../../../packages/bundle/ahv/cordis.patch.bot.yml', import.meta.url), 'utf8')
  const runner = bot.split('- id: bot-runner')[1]
  assert.match(runner, /\n        systemSuffix: !!js "process\.env\.AHV_BOT_SYSTEM_SUFFIX \|\| ''"\n/) }
// `--system-file=PATH` and a repeated flag would otherwise reach dsh unread.
assert.throws(() => prepareBotEnv([`--system-file=${f}`], {}), /system_file_invalid/)
assert.throws(() => prepareBotEnv(['--system-file', f, '--system-file', f], {}), /system_file_invalid/)

// Exactly 64 KiB still fits; a missing file, a dangling flag and non-UTF-8 bytes do not.
{ const edge = join(dir, 'edge.md'); writeFileSync(edge, 'x'.repeat(64 * 1024))
  assert.equal(prepareBotEnv(['--system-file', edge], {}).env.AHV_BOT_SYSTEM_SUFFIX.length, 64 * 1024) }
assert.throws(() => prepareBotEnv(['--system-file', join(dir, 'nope.md')], {}), /system_file_invalid/)
assert.throws(() => prepareBotEnv(['--system-file'], {}), /system_file_invalid/)
{ const bad = join(dir, 'bad.md'); writeFileSync(bad, Buffer.from([0x4c, 0xff, 0xfe]))
  assert.throws(() => prepareBotEnv(['--system-file', bad], {}), /system_file_invalid/) }
// The caller's env is not mutated.
{ const env = { AHV_BOT_SYSTEM_SUFFIX: 'giữ' }; prepareBotEnv(['-p', 'hi'], env)
  assert.equal(env.AHV_BOT_SYSTEM_SUFFIX, 'giữ') }

// Through the CLI: a bad file is a JSONL error with exit 2 before dsh is spawned,
// and `ahv run --help` names the flag (the bot probes for it).
const BIN = fileURLToPath(new URL('../ahv-bot.mjs', import.meta.url))
function cli(args, env) {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) { return { code: e.status, out: String(e.stdout ?? '') } }
}
{ const r = cli(['run', '--system-file', join(dir, 'nope.md'), '--output', 'jsonl'], { ...process.env, AHV_API_KEY: 'sk-test', AHV_FORK: dir })
  assert.equal(r.code, 2)
  const err = JSON.parse(r.out.trim().split('\n').pop())
  assert.equal(err.type, 'error'); assert.equal(err.code, 'system_file_invalid') }
{ const env = { ...process.env, AHV_FORK: dir }; delete env.AHV_API_KEY
  const r = cli(['run', '--help'], env)
  assert.match(r.out, /--system-file/) }

// runBot hands dsh the prepared argv and env. A fake fork's bin.ts records what
// it received; `tsx/esm` is an empty module because Node strips the types.
{ const fork = join(dir, 'fork'); const rec = join(dir, 'rec.json')
  mkdirSync(join(fork, 'apps/cli/src'), { recursive: true })
  mkdirSync(join(fork, 'node_modules/tsx'), { recursive: true })
  writeFileSync(join(fork, 'node_modules/tsx/package.json'), JSON.stringify({ name: 'tsx', type: 'module', exports: { './esm': './esm.mjs' } }))
  writeFileSync(join(fork, 'node_modules/tsx/esm.mjs'), '')
  writeFileSync(join(fork, 'apps/cli/src/bin.ts'), `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.FAKE_DSH_RECORD, JSON.stringify({ argv: process.argv.slice(2), suffix: process.env.AHV_BOT_SYSTEM_SUFFIX ?? null }))
`)
  const env = { ...process.env, AHV_API_KEY: 'sk-test', AHV_FORK: fork, FAKE_DSH_RECORD: rec, AHV_BOT_SYSTEM_SUFFIX: 'thừa kế' }
  const raw = 'Dùng {{model}}, {{ten}}, {{1}}, {{ lẻ, }} lẻ'
  const sf = join(dir, 'raw.md'); writeFileSync(sf, raw)
  const args = ['--prompt-file', 'p.md', '--output', 'jsonl']
  { const r = cli(['run', '--system-file', sf, ...args], env); assert.equal(r.code, 0)
    const got = JSON.parse(readFileSync(rec, 'utf8'))
    assert.deepEqual(got.argv.slice(got.argv.indexOf('--') + 1), args)
    assert.equal(got.suffix, raw) }
  { const r = cli(['run', ...args], env); assert.equal(r.code, 0)
    const got = JSON.parse(readFileSync(rec, 'utf8'))
    assert.deepEqual(got.argv.slice(got.argv.indexOf('--') + 1), args)
    assert.equal(got.suffix, null) } }
console.log('ok test-system-file')
