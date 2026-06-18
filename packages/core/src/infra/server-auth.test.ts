import { Effect, Layer, ManagedRuntime, Stream } from 'effect'
import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { io as ioClient, type Socket } from 'socket.io-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatService } from '../domain/chat/chat-service'
import { type TimmyConfig } from '../domain/config/config'
import type { StreamChunk } from '../domain/llm/stream-chunk'
import { buildServer } from './server'

vi.mock('./permission-cli', () => ({
  addAllowedCommand: vi.fn(),
  setOverride: vi.fn(),
  setMode: vi.fn(),
}))

// Auth ENABLED with a literal token (not 'keychain', so no CredentialStore needed). Even on loopback
// a configured token is enforced — the loopback exemption only applies when no token is set.
const AUTH_CONFIG = {
  server: { host: '127.0.0.1', port: 0, auth: { enabled: true, token: 'secret-xyz' } },
} as unknown as TimmyConfig

const fakeChat = () =>
  Layer.succeed(
    ChatService,
    ChatService.of({
      send: () =>
        Effect.succeed({
          threadId: 't1',
          stream: Stream.fromIterable([
            { type: 'content', content: 'hi' },
            { type: 'finish', reason: 'stop' },
          ] as StreamChunk[]),
        }),
    }),
  )

function connect(url: string, auth?: Record<string, unknown>): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = ioClient(url, {
      path: '/stream',
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth,
    })
    sock.on('connect', () => resolve(sock))
    sock.on('connect_error', (e) => reject(e))
  })
}

describe('/stream WS handshake auth', () => {
  let app: FastifyInstance
  let runtime: ManagedRuntime.ManagedRuntime<never, never>
  let sock: Socket | undefined
  let url: string

  const mount = async () => {
    runtime = ManagedRuntime.make(fakeChat())
    app = await buildServer(AUTH_CONFIG, runtime as never)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const { port } = app.server.address() as AddressInfo
    url = `http://127.0.0.1:${port}`
  }

  afterEach(async () => {
    sock?.close()
    await app?.close()
    await runtime?.dispose()
  })

  it('rejects a handshake with no token', async () => {
    await mount()
    await expect(connect(url)).rejects.toThrow(/unauthorized/i)
  })

  it('rejects a handshake with a wrong token', async () => {
    await mount()
    await expect(connect(url, { token: 'nope' })).rejects.toThrow(/unauthorized/i)
  })

  it('accepts a handshake with the correct token and serves the turn', async () => {
    await mount()
    sock = await connect(url, { token: 'secret-xyz' })
    const got = await new Promise<StreamChunk[]>((resolve) => {
      const chunks: StreamChunk[] = []
      sock!.on('chunk', (c: StreamChunk) => chunks.push(c))
      sock!.once('done', () => resolve(chunks))
      sock!.emit('chat', { message: 'hi' })
    })
    expect(got).toContainEqual({ type: 'content', content: 'hi' })
  })
})
