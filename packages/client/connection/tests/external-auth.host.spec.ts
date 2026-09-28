// AHV fork: `browserAuth: 'external'` for a loopback bind behind a login gate.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { BrowserAuth } from '../src/browser-auth.ts'
import { HostConnectionService } from '../src/rpc-host.ts'

async function service(browserAuth: BrowserAuth | undefined): Promise<{ ctx: Context; connection: () => HostConnectionService }> {
  const ctx = new Context()
  const fiber = ctx.plugin((owner) => { new HostConnectionService(owner, [], browserAuth) })
  await fiber.await()
  return { ctx, connection: () => ctx.get('connection') as HostConnectionService }
}

const loopback = { method: 'GET', url: '/api/x', headers: { host: '127.0.0.1:3080' } }
const foreign = { method: 'GET', url: '/api/x', headers: { host: 'evil.example:3080', origin: 'http://evil.example:3080' } }

describe('external browser authentication', () => {
  it('admits a trusted request without a session cookie', async () => {
    const { connection } = await service(undefined)
    expect(connection().admit(loopback as never)).toHaveProperty('peer')
  })

  it('still applies the Host/Origin fence', async () => {
    const { connection } = await service(undefined)
    expect(connection().admit(foreign as never)).toEqual({ rejection: 403 })
  })

  it('serves the index and prints the clean URL', async () => {
    const { connection } = await service(undefined)
    expect(connection().authorizeIndex({ method: 'GET', url: '/', headers: loopback.headers } as never, {} as never)).toBe(true)
    expect(connection().authenticatedUrl('http://127.0.0.1:3080/')).toBe('http://127.0.0.1:3080/')
  })

  it('token mode keeps refusing a request without a cookie', async () => {
    const auth = { isAuthenticated: () => false } as unknown as BrowserAuth
    const { connection } = await service(auth)
    expect(connection().admit(loopback as never)).toEqual({ rejection: 401 })
  })
})
