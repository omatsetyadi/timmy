import { Effect, Layer, ManagedRuntime, Stream } from 'effect'
import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { io as ioClient, type Socket } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatService } from '../domain/chat/chat-service'
import { type TimmyConfig } from '../domain/config/config'
import type { StreamChunk } from '../domain/llm/stream-chunk'
import { PendingConfirmations } from '../domain/tools/confirmations'
import { PermissionOverlay } from '../domain/tools/permission-overlay'
import { buildServer } from './server'

// The confirm "always" branch writes through to config.yaml via permission-cli; stub it so the
// test never touches ~/.timmy/config.yaml (mirrors server.test.ts), assert on the calls instead.
const addAllowedCommand = vi.fn()
const setOverride = vi.fn()
const setMode = vi.fn()
vi.mock('./permission-cli', () => ({
  addAllowedCommand: (sig: string) => addAllowedCommand(sig),
  setOverride: (kind: 'tool' | 'plugin', name: string, perm: string) =>
    setOverride(kind, name, perm),
  setMode: (mode: string) => setMode(mode),
}))

// Auth disabled so the socket connects without a handshake token (loopback).
const TEST_CONFIG = {
  server: { host: '127.0.0.1', port: 0, auth: { enabled: false, token: 'keychain' } },
} as unknown as TimmyConfig

type AlwaysPayload = { scope: 'command'; signature: string } | { scope: 'tool'; tool: string }
type ChatTurn = { threadId: string; stream: Stream.Stream<StreamChunk, never> }

/** A fake ChatService so the bridge can be driven with a controlled chunk stream. */
const fakeChat = (send: () => ChatTurn) =>
  Layer.succeed(ChatService, ChatService.of({ send: () => Effect.succeed(send()) }))

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

/** Collect all `thread`/`chunk` events for one turn, resolving when `done` arrives. */
function collectTurn(sock: Socket): Promise<{ threads: unknown[]; chunks: StreamChunk[] }> {
  return new Promise((resolve) => {
    const threads: unknown[] = []
    const chunks: StreamChunk[] = []
    sock.on('thread', (t) => threads.push(t))
    sock.on('chunk', (c: StreamChunk) => chunks.push(c))
    sock.once('done', () => resolve({ threads, chunks }))
  })
}

function waitFor<T = unknown>(sock: Socket, event: string): Promise<T> {
  return new Promise((resolve) => sock.once(event, resolve as (v: unknown) => void))
}

async function waitUntil(pred: () => Promise<boolean> | boolean, ms = 1000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('waitUntil timed out')
}

describe('/stream WS bridge — chat', () => {
  let app: FastifyInstance
  let runtime: ManagedRuntime.ManagedRuntime<never, never>
  let sock: Socket
  let serverUrl: string

  const mount = async (layer: Layer.Layer<never, never, never>) => {
    runtime = ManagedRuntime.make(layer)
    app = await buildServer(TEST_CONFIG, runtime as never)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const { port } = app.server.address() as AddressInfo
    serverUrl = `http://127.0.0.1:${port}`
  }

  afterEach(async () => {
    sock?.close()
    await app?.close()
    await runtime?.dispose()
  })

  it('emits thread, then each chunk, then done for a turn', async () => {
    const chunks: StreamChunk[] = [
      { type: 'content', content: 'Hello' },
      { type: 'content', content: ' world' },
      { type: 'finish', reason: 'stop' },
    ]
    await mount(fakeChat(() => ({ threadId: 't1', stream: Stream.fromIterable(chunks) })))
    sock = await connect(serverUrl)
    const turn = collectTurn(sock)
    sock.emit('chat', { message: 'hi' })
    const got = await turn
    expect(got.threads).toEqual([{ thread_id: 't1' }])
    expect(got.chunks).toEqual(chunks)
  })

  it('passes a confirm_required chunk through with its id intact', async () => {
    const confirm: StreamChunk = {
      type: 'confirm_required',
      id: 'c1',
      tool: 'runCommand',
      description: 'command: git status',
      always: { scope: 'command', label: 'git status' },
    }
    await mount(fakeChat(() => ({ threadId: 't1', stream: Stream.fromIterable([confirm]) })))
    sock = await connect(serverUrl)
    const turn = collectTurn(sock)
    sock.emit('chat', { message: 'run git status' })
    const got = await turn
    expect(got.chunks).toContainEqual(confirm)
  })

  it('rejects a chat with no message via an error chunk + done', async () => {
    await mount(fakeChat(() => ({ threadId: 'x', stream: Stream.empty })))
    sock = await connect(serverUrl)
    const turn = collectTurn(sock)
    sock.emit('chat', {})
    const got = await turn
    expect(got.chunks).toEqual([{ type: 'error', message: 'message (string) is required' }])
  })

  it('interrupt stops the in-flight turn and emits a final done', async () => {
    const stream = Stream.concat(
      Stream.make({ type: 'content', content: 'thinking…' } as StreamChunk),
      Stream.never,
    )
    await mount(fakeChat(() => ({ threadId: 't_int', stream })))
    sock = await connect(serverUrl)
    const done = waitFor(sock, 'done')
    const firstChunk = waitFor(sock, 'chunk')
    sock.emit('chat', { message: 'hang please' })
    await firstChunk
    sock.emit('interrupt', {})
    await done // resolves only if interrupt produced the final done
  })

  it('a new chat interrupts the active turn (a second thread arrives)', async () => {
    let n = 0
    const send = (): ChatTurn => {
      n += 1
      const stream =
        n === 1
          ? Stream.concat(
              Stream.make({ type: 'content', content: 'first' } as StreamChunk),
              Stream.never,
            )
          : Stream.fromIterable([
              { type: 'content', content: 'second' },
              { type: 'finish', reason: 'stop' },
            ] as StreamChunk[])
      return { threadId: `t${n}`, stream }
    }
    await mount(fakeChat(send))
    sock = await connect(serverUrl)
    const threads: Array<{ thread_id: string }> = []
    sock.on('thread', (t: { thread_id: string }) => threads.push(t))
    const firstChunk = waitFor(sock, 'chunk')
    sock.emit('chat', { message: 'one' })
    await firstChunk
    sock.emit('chat', { message: 'two' })
    await waitUntil(() => threads.length >= 2)
    expect(threads.map((t) => t.thread_id)).toEqual(['t1', 't2'])
  })

  it('two chats racing during send → only the latest streams (no concurrent turns)', async () => {
    let n = 0
    // Both `chat` events enter the handler and await send before either resolves (the race window).
    // The turn-token guard must drop the stale first turn so only the second streams.
    const layer = Layer.succeed(
      ChatService,
      ChatService.of({
        send: () =>
          Effect.sync(() => {
            n += 1
            const id = n
            return {
              threadId: `t${id}`,
              stream: Stream.fromIterable([
                { type: 'content', content: `turn${id}` },
                { type: 'finish', reason: 'stop' },
              ] as StreamChunk[]),
            }
          }).pipe(Effect.delay('25 millis')),
      }),
    )
    await mount(layer)
    sock = await connect(serverUrl)
    const threads: Array<{ thread_id: string }> = []
    const contents: string[] = []
    sock.on('thread', (t: { thread_id: string }) => threads.push(t))
    sock.on('chunk', (c: StreamChunk) => c.type === 'content' && contents.push(c.content))
    sock.emit('chat', { message: 'one' })
    sock.emit('chat', { message: 'two' }) // races the first before its send resolves
    await new Promise((r) => setTimeout(r, 120))
    expect(threads).toHaveLength(1) // exactly one turn reached the socket
    expect(threads[0].thread_id).toBe('t2') // the latest
    expect(contents).toEqual(['turn2']) // no interleaving from the dropped first turn
  })

  it('disconnecting mid-turn interrupts cleanly (no crash)', async () => {
    const stream = Stream.concat(
      Stream.make({ type: 'content', content: 'mid' } as StreamChunk),
      Stream.never,
    )
    await mount(fakeChat(() => ({ threadId: 't_d', stream })))
    sock = await connect(serverUrl)
    const firstChunk = waitFor(sock, 'chunk')
    sock.emit('chat', { message: 'go' })
    await firstChunk
    sock.close() // disconnect mid-turn → server interrupts the fiber
    await new Promise((r) => setTimeout(r, 50))
    expect(true).toBe(true) // reaching here without an unhandled rejection is the assertion
  })
})

describe('/stream WS bridge — confirm', () => {
  let app: FastifyInstance
  let runtime: ManagedRuntime.ManagedRuntime<PendingConfirmations | PermissionOverlay, never>
  let sock: Socket

  beforeEach(() => {
    addAllowedCommand.mockClear()
    setOverride.mockClear()
  })

  afterEach(async () => {
    sock?.close()
    await app?.close()
    await runtime?.dispose()
  })

  const overlay = () => runtime.runPromise(PermissionOverlay.pipe(Effect.flatMap((o) => o.get)))
  const createPending = (id: string, always: AlwaysPayload) =>
    runtime.runPromise(PendingConfirmations.pipe(Effect.flatMap((p) => p.create(id, always))))

  it("confirm {decision:'always'} (command) resolves + mutates the live overlay + persists", async () => {
    runtime = ManagedRuntime.make(Layer.merge(PendingConfirmations.Live, PermissionOverlay.Live))
    app = await buildServer(TEST_CONFIG, runtime as never)
    await app.listen({ host: '127.0.0.1', port: 0 })
    await createPending('c1', { scope: 'command', signature: 'git commit' })

    const { port } = app.server.address() as AddressInfo
    sock = await connect(`http://127.0.0.1:${port}`)
    sock.emit('confirm', { id: 'c1', decision: 'always' })

    await waitUntil(async () => (await overlay()).commands.includes('git commit'))
    expect(addAllowedCommand).toHaveBeenCalledWith('git commit')
  })

  it('a confirm with no/invalid decision is ignored — the pending entry is NOT consumed', async () => {
    runtime = ManagedRuntime.make(Layer.merge(PendingConfirmations.Live, PermissionOverlay.Live))
    app = await buildServer(TEST_CONFIG, runtime as never)
    await app.listen({ host: '127.0.0.1', port: 0 })
    await createPending('c2', { scope: 'command', signature: 'git push' })
    const { port } = app.server.address() as AddressInfo
    sock = await connect(`http://127.0.0.1:${port}`)

    sock.emit('confirm', { id: 'c2' }) // malformed — no decision
    await new Promise((r) => setTimeout(r, 50))
    // Still pending: a subsequent VALID confirm must still resolve + mutate the overlay.
    sock.emit('confirm', { id: 'c2', decision: 'always' })
    await waitUntil(async () => (await overlay()).commands.includes('git push'))
    expect(addAllowedCommand).toHaveBeenCalledWith('git push')
  })
})
