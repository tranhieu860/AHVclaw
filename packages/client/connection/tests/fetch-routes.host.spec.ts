/** Exact Fetch routes on the shared /api channel (backport of upstream e5e4b02742). */
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH, apply, inject, type HostConnectionHandle } from '../src/index.ts'
import { HostConnectionService } from '../src/rpc-host.ts'

async function service(): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin((pluginCtx) => {
    new HostConnectionService(pluginCtx, [])
  })
  await fiber.await()
  return {
    connection: ctx.get('connection') as HostConnectionService,
    dispose: () => fiber.dispose(),
  }
}

describe('Connection exact Fetch routes', () => {
  it('dispatches owned methods before the shared-channel fallback', async () => {
    const { connection, dispose: disposeFiber } = await service()
    const route = vi.fn(async (request: Request) =>
      Response.json({ query: new URL(request.url).searchParams.get('sessionId') }))
    const fallback = vi.fn(async () => new Response('fallback', { status: 418 }))
    const dispose = connection.fetch.register({
      path: '/api/session.export',
      methods: ['GET', 'HEAD'],
      fetch: route,
    })
    const shared = connection.createSharedFetchHandler('/api', { fetch: fallback })

    const response = await shared.fetch(new Request('http://host/api/session.export?sessionId=session-1'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ query: 'session-1' })
    expect(route).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()

    const post = await shared.fetch(new Request('http://host/api/session.export', { method: 'POST' }))
    expect(post.status).toBe(418)
    expect(fallback).toHaveBeenCalledOnce()

    await dispose()
    const withdrawn = await shared.fetch(new Request('http://host/api/session.export'))
    expect(withdrawn.status).toBe(418)
    expect(fallback).toHaveBeenCalledTimes(2)
    await disposeFiber()
  })

  it('rejects invalid and duplicate registrations', async () => {
    const { connection, dispose: disposeFiber } = await service()
    const fetch = async (): Promise<Response> => new Response()

    expect(() => connection.fetch.register({ path: '/outside', methods: ['GET'], fetch }))
      .toThrow('invalid exact Fetch route')
    expect(() => connection.fetch.register({ path: '/api/../x', methods: ['GET'], fetch }))
      .toThrow('invalid exact Fetch route')
    expect(() => connection.fetch.register({ path: '/api/session.export', methods: [], fetch }))
      .toThrow('declares no methods')
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['GET', 'GET'], fetch,
    })).toThrow('repeats a method')

    const dispose = connection.fetch.register({ path: '/api/session.export', methods: ['GET'], fetch })
    expect(() => connection.fetch.register({ path: '/api/session.export', methods: ['HEAD'], fetch }))
      .toThrow('already registered')
    await dispose()
    expect(() => connection.fetch.register({ path: '/api/session.export', methods: ['HEAD'], fetch }))
      .not.toThrow()
    await disposeFiber()
  })

  // Shape used by dsh-plugin-subscriptions >= 0.9: a buffered JSON POST route.
  it('serves a buffered POST route through the /api fence and still rejects untrusted hosts', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', {
      register(route: WebRoute) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
      registerUpgrade: () => () => {},
      tapIndex: () => () => {},
      port: 0,
    } as unknown as WebServer)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const seen: unknown[] = []
    connection.fetch.register({
      path: `${API_PATH}/subscriptions-auth.status`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        seen.push(await request.json())
        return Response.json({ ok: true })
      },
    })
    const api = routes.find(route => route.path === API_PATH)!

    const post = (host: string): { request: IncomingMessage; state: { status?: number; body?: string }; response: ServerResponse } => {
      const request = Readable.from([Buffer.from('{"rpcId":"r1"}')]) as unknown as IncomingMessage
      Object.assign(request, {
        url: `${API_PATH}/subscriptions-auth.status`,
        method: 'POST',
        headers: { host, 'content-type': 'application/json' },
      })
      const state: { status?: number; body?: string } = {}
      const chunks: Buffer[] = []
      const response = {
        writableEnded: false,
        on() { return this },
        once() { return this },
        writeHead(status: number) { state.status = status; return this },
        write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
        end(this: { writableEnded: boolean }, value?: string | Uint8Array) {
          if (value !== undefined) chunks.push(Buffer.from(value))
          state.body = Buffer.concat(chunks).toString()
          this.writableEnded = true
          return this
        },
      } as unknown as ServerResponse
      return { request, state, response }
    }

    const trusted = post('harness.example')
    await api.handler(trusted.request, trusted.response)
    expect(trusted.state.status).toBe(200)
    expect(JSON.parse(trusted.state.body!)).toEqual({ ok: true })
    expect(seen).toEqual([{ rpcId: 'r1' }])

    const untrusted = post('evil.example')
    await api.handler(untrusted.request, untrusted.response)
    expect(untrusted.state.status).toBe(403)
    expect(seen).toHaveLength(1)
    await fiber.dispose()
  })
})
