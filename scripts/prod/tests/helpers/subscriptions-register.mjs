// Opt-in lightweight peer adapter for the published-plugin smoke, without node_modules.
import { register, syncBuiltinESMExports } from 'node:module'
import { Socket } from 'node:net'
import childProcess from 'node:child_process'

// Endpoint fixtures replace fetch explicitly. All other outbound sockets fail closed.
globalThis.fetch = async () => { throw new Error('subscriptions test blocked an unstubbed fetch') }
Socket.prototype.connect = function () { throw new Error('subscriptions test blocked an outbound socket') }
childProcess.execFileSync = function () { throw new Error('subscriptions test blocked a credential or CLI subprocess') }
syncBuiltinESMExports()
register('./subscriptions-loader.mjs', import.meta.url)
