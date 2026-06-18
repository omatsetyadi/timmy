import { Effect, Layer, ManagedRuntime, Stream } from 'effect'
import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { io as ioClient, type Socket } from 'socket.io-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatService } from '../domain/chat/chat-service'
import { type TimmyConfig } from '../domain/config/config'
import { Notifier, type Notification } from '../domain/notify/notifier'
import { buildServer } from './server'

vi.mock('./permission-cli', () => ({
  addAllowedCommand: vi.fn(),
  setOverride: vi.fn(),
  setMode: vi.fn(),
}))

// Auth off so the socket connects without a token (loopback).
const TEST_CONFIG = {
  server: { host: '127.0.0.1', port: 0, auth: { enabled: false, token: 'keychain' } },
} as unknown as TimmyConfig

const fakeChat = () =>
  Layer.succeed(
    ChatService,
    ChatService.of({ send: () => Effect.succeed({ threadId: 't', stream: Stream.empty }) }),
  )

function connect(url: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = ioClient(url, {
      path: '/stream',
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    })
    sock.on('connect', () => resolve(sock))
    sock.on('connect_error', reject)
  })
}

describe('/stream notify (proactive push)', () => {
  let app: FastifyInstance
  let runtime: ManagedRuntime.ManagedRuntime<Notifier, never>
  let sock: Socket | undefined

  afterEach(async () => {
    sock?.close()
    await app?.close()
    await runtime?.dispose()
  })

  it('Notifier.notify reaches a connected socket as a notify event with the payload', async () => {
    runtime = ManagedRuntime.make(Layer.merge(fakeChat(), Notifier.Live))
    app = await buildServer(TEST_CONFIG, runtime as never)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const { port } = app.server.address() as AddressInfo
    sock = await connect(`http://127.0.0.1:${port}`)

    const got = new Promise<Notification>((resolve) => sock!.once('notify', resolve))
    await runtime.runPromise(
      Notifier.pipe(
        Effect.flatMap((n) =>
          n.notify({ text: 'Build finished — want to check?', thread_id: 't9' }),
        ),
      ),
    )
    expect(await got).toEqual({ text: 'Build finished — want to check?', thread_id: 't9' })
  })
})
