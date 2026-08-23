#!/usr/bin/env node
// The CLI must dispatch when invoked through a symlinked path.
// Deployments symlink ~/.ahv/bin per service user, so comparing
// import.meta.url (real path) against argv[1] (symlinked path) silently
// disables every subcommand.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = join(process.env.HOME, '.ahv', 'bin', 'ahv-bot.mjs')
let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`) }
}

function runJson(binPath, args, home) {
  const out = execFileSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home ?? process.env.HOME },
  })
  assert.notEqual(out.trim(), '', 'command produced no output')
  return JSON.parse(out.trim().split('\n').filter(l => l.startsWith('{')).pop())
}

test('dispatches when invoked by its real path', () => {
  const d = runJson(BIN, ['auth', 'status', '--json'])
  assert.ok('logged_in' in d)
})

test('dispatches when invoked through a symlinked directory', () => {
  // Mirrors the deployment layout: /home/<svc>/.ahv/bin -> /home/<owner>/.ahv/bin
  const root = mkdtempSync(join(tmpdir(), 'ahv-symlink-'))
  mkdirSync(join(root, '.ahv'), { recursive: true })
  symlinkSync(join(process.env.HOME, '.ahv', 'bin'), join(root, '.ahv', 'bin'))
  const d = runJson(join(root, '.ahv', 'bin', 'ahv-bot.mjs'), ['auth', 'status', '--json'])
  assert.ok('logged_in' in d)
})

test('dispatches through a symlink to the file itself', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahv-filelink-'))
  const link = join(root, 'ahv-bot.mjs')
  symlinkSync(BIN, link)
  const d = runJson(link, ['auth', 'status', '--json'])
  assert.ok('logged_in' in d)
})

test('login status dispatches through a symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahv-login-'))
  mkdirSync(join(root, '.ahv'), { recursive: true })
  symlinkSync(join(process.env.HOME, '.ahv', 'bin'), join(root, '.ahv', 'bin'))
  const d = runJson(join(root, '.ahv', 'bin', 'ahv-bot.mjs'), ['login', 'status', '--json'])
  assert.ok('providers' in d)
})

test('still importable without running the CLI', async () => {
  const mod = await import(BIN)
  assert.equal(typeof mod.importCliCredentials, 'function')
  assert.equal(typeof mod.decodeJwtExpiry, 'function')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
