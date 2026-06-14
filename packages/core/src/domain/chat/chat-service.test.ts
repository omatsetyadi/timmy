import { it } from '@effect/vitest'
import { Chunk, Effect, Either, Fiber, Layer, Stream } from 'effect'
import { expect } from 'vitest'
import type { Tool } from 'timmy-sdk'
import { ChatService } from './chat-service'
import { LlmClient } from '../llm/llm-client'
import { ThreadStore } from '../persistence/thread-store'
import { SqlError } from '../persistence/errors'
import { Config } from '../config/config'
import { ToolRegistry } from '../tools/tool-registry'
import { ToolSource } from '../tools/tool-source'
import { SafeExecution } from '../tools/safe-execution'
import { PendingConfirmations } from '../tools/confirmations'

const ConfigStub = Config.Live(`${process.cwd()}/__nope__.yaml`) // defaults

// Tools wiring for ChatService.Live's new deps. ToolSource.empty → no tools,
// so the loop makes a single turn and behaves exactly like the foundation.
const EmptyToolsLayer = Layer.mergeAll(
  ToolRegistry.Live.pipe(Layer.provide(ToolSource.empty)),
  SafeExecution.Live.pipe(Layer.provide(PendingConfirmations.Live)),
)
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
      ChatService.Live.pipe(
        Layer.provide(Layer.mergeAll(ConfigStub, ThreadStub, LlmStub, EmptyToolsLayer)),
      ),
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
          Layer.provide(Layer.mergeAll(ConfigStub, FailingThreadStub, LlmStub, EmptyToolsLayer)),
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
          Layer.provide(
            Layer.mergeAll(ConfigStub, HangingThreadStub, HangingLlmStub, EmptyToolsLayer),
          ),
        ),
      ),
    )

    // The ensuring finalizer ran on interrupt and persisted what we had so far.
    expect(persisted.find((m) => m.role === 'assistant')?.content).toBe('partial')
  }),
)

// ---------------------------------------------------------------------------
// Task 6: the agentic tool-loop
// ---------------------------------------------------------------------------

const echo: Tool = {
  name: 'echo',
  description: 'echoes its input',
  riskLevel: 'safe',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: async (args) => ({ ok: true, data: (args as { text?: string }).text }),
}

// A scripted LlmClient: each entry in `turns` is the chunks a single chat() call yields.
// The closure tracks how many times chat() has been called and returns the next script.
const scriptedLlm = (turns: StreamChunkArray[]) => {
  let call = 0
  return Layer.succeed(
    LlmClient,
    LlmClient.of({
      chat: () => {
        const idx = Math.min(call, turns.length - 1)
        call += 1
        return Stream.fromIterable(turns[idx]!)
      },
      isAvailable: () => Effect.succeed(true),
      detectCapabilities: () =>
        Effect.succeed({ tools: true, vision: false, audio: false, realtime: false }),
    }),
  )
}
type StreamChunkArray = ReadonlyArray<
  | { type: 'content'; content: string }
  | { type: 'tool_call'; toolCall: { id: string; name: string; arguments: string } }
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool_calls' }
  | { type: 'error'; message: string }
>

// A registry stub that counts executions, so the test can assert "ran once".
const countingRegistry = () => {
  const counter = { executed: 0 }
  const layer = Layer.succeed(
    ToolRegistry,
    ToolRegistry.of({
      list: () => [echo],
      toModelTools: () => [
        { type: 'function', function: { name: 'echo', description: 'echoes', parameters: {} } },
      ],
      execute: (_name, args) =>
        Effect.sync(() => {
          counter.executed += 1
          return { ok: true, data: (args as { text?: string }).text }
        }),
    }),
  )
  return { counter, layer }
}

it.live('runs the tool-loop: tool_call -> execute -> continue -> content', () => {
  const { counter, layer: RegistryStub } = countingRegistry()
  return Effect.gen(function* () {
    const chat = yield* ChatService
    const { stream } = yield* chat.send({ message: 'echo hi' })
    const chunks = Chunk.toArray(yield* Stream.runCollect(stream))
    expect(chunks.some((c) => c.type === 'tool_call')).toBe(true)
    expect(chunks.some((c) => c.type === 'content')).toBe(true)
    expect(counter.executed).toBe(1)
  }).pipe(
    Effect.provide(
      ChatService.Live.pipe(
        Layer.provide(
          Layer.mergeAll(
            ConfigStub,
            ThreadStub,
            scriptedLlm([
              // turn 1: model calls echo, then finishes
              [
                {
                  type: 'tool_call',
                  toolCall: { id: 'c1', name: 'echo', arguments: '{"text":"hi"}' },
                },
                { type: 'finish', reason: 'tool_calls' },
              ],
              // turn 2 (after tool result appended): plain content + finish
              [
                { type: 'content', content: 'you said hi' },
                { type: 'finish', reason: 'stop' },
              ],
            ]),
            RegistryStub,
            SafeExecution.Live.pipe(Layer.provide(PendingConfirmations.Live)),
          ),
        ),
      ),
    ),
  )
})

it.live('stops at MAX_TOOL_ITERATIONS, emitting an error chunk', () =>
  Effect.gen(function* () {
    const chat = yield* ChatService
    const { stream } = yield* chat.send({ message: 'loop forever' })
    const chunks = Chunk.toArray(yield* Stream.runCollect(stream))
    // last chunk is the max-iterations error
    const last = chunks[chunks.length - 1]
    expect(last?.type).toBe('error')
    if (last?.type === 'error') expect(last.message).toContain('max tool iterations')
  }).pipe(
    Effect.provide(
      ChatService.Live.pipe(
        Layer.provide(
          Layer.mergeAll(
            ConfigStub,
            ThreadStub,
            // ALWAYS yields a tool_call + finish → never terminates on its own.
            scriptedLlm([
              [
                {
                  type: 'tool_call',
                  toolCall: { id: 'c', name: 'echo', arguments: '{"text":"x"}' },
                },
                { type: 'finish', reason: 'tool_calls' },
              ],
            ]),
            Layer.succeed(
              ToolRegistry,
              ToolRegistry.of({
                list: () => [echo],
                toModelTools: () => [
                  {
                    type: 'function',
                    function: { name: 'echo', description: 'echoes', parameters: {} },
                  },
                ],
                execute: (_name, args) =>
                  Effect.succeed({ ok: true, data: (args as { text?: string }).text }),
              }),
            ),
            SafeExecution.Live.pipe(Layer.provide(PendingConfirmations.Live)),
          ),
        ),
      ),
    ),
  ),
)

// ---------------------------------------------------------------------------
// Task 7: surface the confirm flow mid-stream
// ---------------------------------------------------------------------------

const confirmTool: Tool = {
  name: 'danger',
  description: 'needs confirmation',
  riskLevel: 'confirm',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async () => ({ ok: true, data: 'ran' }),
}

// A confirm-tier registry: list() returns the confirm tool; execute() counts runs.
const confirmRegistry = () => {
  const counter = { executed: 0 }
  const layer = Layer.succeed(
    ToolRegistry,
    ToolRegistry.of({
      list: () => [confirmTool],
      toModelTools: () => [
        { type: 'function', function: { name: 'danger', description: 'danger', parameters: {} } },
      ],
      execute: () =>
        Effect.sync(() => {
          counter.executed += 1
          return { ok: true, data: 'ran' }
        }),
    }),
  )
  return { counter, layer }
}

it.live('confirm flow: emits confirm_required, resolves, then tool runs + content', () => {
  const { counter, layer: RegistryStub } = confirmRegistry()
  return Effect.gen(function* () {
    const pc = yield* PendingConfirmations
    const chat = yield* ChatService
    const { stream } = yield* chat.send({ message: 'do the danger thing' })

    // The loop blocks inside SafeExecution awaiting confirmation of tool_call
    // 'k1' (the scripted tool_call id). Fork a responder that approves it once
    // it's pending; the MAIN fiber drives the stream via runCollect.
    yield* Effect.fork(
      Effect.gen(function* () {
        for (let i = 0; i < 300; i++) {
          const resolved = yield* pc.resolve('k1', true)
          if (resolved) return
          yield* Effect.sleep('10 millis')
        }
      }),
    )

    const chunks = Chunk.toArray(yield* Stream.runCollect(stream))
    expect(chunks.some((c) => c.type === 'confirm_required')).toBe(true)
    expect(chunks.some((c) => c.type === 'content')).toBe(true)
    expect(counter.executed).toBe(1)
  }).pipe(
    Effect.provide(
      ChatService.Live.pipe(
        // provideMerge (not provide) so the test can resolve the SAME
        // PendingConfirmations instance that SafeExecution awaits.
        Layer.provideMerge(
          Layer.mergeAll(
            ConfigStub,
            ThreadStub,
            scriptedLlm([
              // turn 1: model calls the confirm-tier tool, then finishes
              [
                { type: 'tool_call', toolCall: { id: 'k1', name: 'danger', arguments: '{}' } },
                { type: 'finish', reason: 'tool_calls' },
              ],
              // turn 2 (after the approved tool result): plain content + finish
              [
                { type: 'content', content: 'done the danger thing' },
                { type: 'finish', reason: 'stop' },
              ],
            ]),
            RegistryStub,
            SafeExecution.Live.pipe(Layer.provideMerge(PendingConfirmations.Live)),
          ),
        ),
      ),
    ),
  )
})
