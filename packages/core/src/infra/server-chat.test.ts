import { Effect, Layer, ManagedRuntime, Stream } from 'effect'
import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatService } from '../domain/chat/chat-service'
import { type TimmyConfig } from '../domain/config/config'
import type { StreamChunk } from '../domain/llm/stream-chunk'
import { buildServer } from './server'

// /chat never hits the "always" persist path, but server.ts imports permission-cli at module load;
// stub it so importing buildServer never touches ~/.timmy/config.yaml.
vi.mock('./permission-cli', () => ({
  addAllowedCommand: () => {},
  setOverride: () => {},
  setMode: () => {},
}))

const TEST_CONFIG = {
  server: { host: '127.0.0.1', port: 0, auth: { enabled: false, token: 'keychain' } },
} as unknown as TimmyConfig

const fakeChat = (chunks: StreamChunk[]) =>
  Layer.succeed(
    ChatService,
    ChatService.of({
      send: () => Effect.succeed({ threadId: 't1', stream: Stream.fromIterable(chunks) }),
    }),
  )

describe('POST /chat (NDJSON characterization)', () => {
  let app: FastifyInstance
  let runtime: ManagedRuntime.ManagedRuntime<never, never>

  afterEach(async () => {
    await app?.close()
    await runtime?.dispose()
  })

  it('streams {thread_id} first, then each chunk, then {done:true}, with x-thread-id header', async () => {
    const chunks: StreamChunk[] = [
      { type: 'content', content: 'Hello' },
      { type: 'content', content: ' world' },
      { type: 'finish', reason: 'stop' },
    ]
    runtime = ManagedRuntime.make(fakeChat(chunks))
    app = await buildServer(TEST_CONFIG, runtime as never)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const { port } = app.server.address() as AddressInfo

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })

    expect(res.headers.get('x-thread-id')).toBe('t1')
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines[0]).toEqual({ thread_id: 't1' })
    expect(lines).toContainEqual({ type: 'content', content: 'Hello' })
    expect(lines).toContainEqual({ type: 'content', content: ' world' })
    expect(lines[lines.length - 1]).toEqual({ done: true })
  })

  it('returns 400 when message is missing', async () => {
    runtime = ManagedRuntime.make(fakeChat([]))
    app = await buildServer(TEST_CONFIG, runtime as never)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const { port } = app.server.address() as AddressInfo

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'message (string) is required' })
  })
})
