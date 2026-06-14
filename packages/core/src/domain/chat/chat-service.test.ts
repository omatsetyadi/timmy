import { it } from '@effect/vitest'
import { Chunk, Effect, Either, Fiber, Layer, Stream } from 'effect'
import { expect } from 'vitest'
import { ChatService } from './chat-service'
import { LlmClient } from '../llm/llm-client'
import { ThreadStore } from '../persistence/thread-store'
import { SqlError } from '../persistence/errors'
import { Config } from '../config/config'

const ConfigStub = Config.Live(`${process.cwd()}/__nope__.yaml`) // defaults
const saved: { role: string; content: string }[] = []
const ThreadStub = Layer.succeed(
  ThreadStore,
  ThreadStore.of({
    createThread: () => Effect.succeed('t1'),
    threadExists: () => Effect.succeed(true),
    addMessage: (_id, role, content) => Effect.sync(() => void saved.push({ role, content })),
    getMessages: () => Effect.succeed([]),
    listThreads: () => Effect.succeed([]),
    getThread: () => Effect.succeed(null),
  }),
)
const LlmStub = Layer.succeed(
  LlmClient,
  LlmClient.of({
    chat: () =>
      Stream.fromIterable([
        { type: 'content', content: 'hi' } as const,
        { type: 'finish', reason: 'stop' } as const,
      ]),
    isAvailable: () => Effect.succeed(true),
    detectCapabilities: () =>
      Effect.succeed({ tools: true, vision: false, audio: false, realtime: false }),
  }),
)

it.effect('creates thread, streams chunks, persists user + assistant', () =>
  Effect.gen(function* () {
    const chat = yield* ChatService
    const { threadId, stream } = yield* chat.send({ message: 'hey' })
    expect(threadId).toBe('t1')
    const chunks = Chunk.toArray(yield* Stream.runCollect(stream))
    expect(chunks.some((c) => c.type === 'content')).toBe(true)
    // assistant persisted after stream completes:
    expect(saved.find((s) => s.role === 'assistant')?.content).toBe('hi')
  }).pipe(
    Effect.provide(
      ChatService.Live.pipe(Layer.provide(Layer.mergeAll(ConfigStub, ThreadStub, LlmStub))),
    ),
  ),
)

// NIT-1: a DB write failure (createThread) must surface as a typed error in
// send's ChatError channel, not be swallowed as a defect via Effect.orDie.
it.effect('surfaces SqlError from createThread as a typed error', () =>
  Effect.gen(function* () {
    const FailingThreadStub = Layer.succeed(
      ThreadStore,
      ThreadStore.of({
        createThread: () => Effect.fail(new SqlError({ message: 'boom' })),
        threadExists: () => Effect.succeed(false),
        addMessage: () => Effect.void,
        getMessages: () => Effect.succeed([]),
        listThreads: () => Effect.succeed([]),
        getThread: () => Effect.succeed(null),
      }),
    )
    const result = yield* ChatService.pipe(
      Effect.flatMap((c) => c.send({ message: 'hi' })),
      Effect.either,
      Effect.provide(
        ChatService.Live.pipe(
          Layer.provide(Layer.mergeAll(ConfigStub, FailingThreadStub, LlmStub)),
        ),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe('timmy/persistence/SqlError')
    }
  }),
)

// spec §9.5: the Stream.ensuring assistant-persist must run even when the
// consumer is interrupted mid-stream (e.g. client disconnects while Ollama
// is still streaming).
it.live('persists accumulated assistant text when stream is interrupted', () =>
  Effect.gen(function* () {
    const persisted: { role: string; content: string }[] = []
    const HangingThreadStub = Layer.succeed(
      ThreadStore,
      ThreadStore.of({
        createThread: () => Effect.succeed('t2'),
        threadExists: () => Effect.succeed(true),
        addMessage: (_id, role, content) =>
          Effect.sync(() => void persisted.push({ role, content })),
        getMessages: () => Effect.succeed([]),
        listThreads: () => Effect.succeed([]),
        getThread: () => Effect.succeed(null),
      }),
    )
    // Emit one content chunk, then hang forever — the consumer must interrupt.
    const HangingLlmStub = Layer.succeed(
      LlmClient,
      LlmClient.of({
        chat: () =>
          Stream.concat(
            Stream.fromIterable([{ type: 'content', content: 'partial' } as const]),
            Stream.never,
          ),
        isAvailable: () => Effect.succeed(true),
        detectCapabilities: () =>
          Effect.succeed({ tools: true, vision: false, audio: false, realtime: false }),
      }),
    )

    const program = Effect.gen(function* () {
      const chat = yield* ChatService
      const { stream } = yield* chat.send({ message: 'hey' })
      // Fork consumption; it will block on the hanging stream after 'partial'.
      const fiber = yield* Stream.runForEach(stream, () => Effect.void).pipe(Effect.fork)
      // Let the first chunk be processed (accumulated into the Ref).
      yield* Effect.sleep('50 millis')
      // Simulate a client disconnect mid-stream.
      yield* Fiber.interrupt(fiber)
    })

    yield* program.pipe(
      Effect.provide(
        ChatService.Live.pipe(
          Layer.provide(Layer.mergeAll(ConfigStub, HangingThreadStub, HangingLlmStub)),
        ),
      ),
    )

    // The ensuring finalizer ran on interrupt and persisted what we had so far.
    expect(persisted.find((m) => m.role === 'assistant')?.content).toBe('partial')
  }),
)
