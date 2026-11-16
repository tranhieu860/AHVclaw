// Test preload: make every child_process.spawn emit an async 'error' (ENOENT), the 'error' branch of spawnListModels.
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
cp.spawn = () => {
  const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => {}
  process.nextTick(() => p.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })))
  return p
}
syncBuiltinESMExports()
