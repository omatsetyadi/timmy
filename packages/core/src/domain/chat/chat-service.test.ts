import { it } from '@effect/vitest'
import { Chunk, Effect, Either, Fiber, Layer, Stream } from 'effect'
import { expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from 'timmy-sdk'
import { ChatService } from './chat-service'
import { LlmClient, type ChatMessage } from '../llm/llm-client'
import { ThreadStore } from '../persistence/thread-store'
import { SqlError } from '../persistence/errors'
import { Config } from '../config/config'
import { CredentialStore } from '../credentials/credential-store'
import { ToolRegistry } from '../tools/tool-registry'
import { ToolSource } from '../tools/tool-source'
import { SafeExecution } from '../tools/safe-execution'
import { PendingConfirmations } from '../tools/confirmations'
import { PermissionOverlay } from '../tools/permission-overlay'
import { ProviderRegistry } from '../llm/provider-registry'
import { Recall } from '../memory/recall'
import { Extractor } from '../memory/extract'

const ConfigStub = Config.Live(`${process.cwd()}/__nope__.yaml`) // defaults

// Memory stubs: recall returns no entities (no block, no memory_recall chunk) and the
// extractor is a no-op, so ChatService behaves exactly as before the memory wiring.
const RecallStub = Layer.succeed(
  Recall,
  Recall.of({
    forMessage: () => Effect.succeed({ block: '', entityNames: [] }),
    search: () => Effect.succeed([]),
  }),
)
const ExtractorStub = Layer.succeed(Extractor, Extractor.of({ extract: () => Effect.void }))
const MemoryStub = Layer.mergeAll(RecallStub, ExtractorStub)

// Tools wiring for ChatService.Live's new deps. ToolSource.empty → no tools,
// so the loop makes a single turn and behaves exactly like the foundation.
// ToolRegistry.Live now also depends on CredentialStore (per-plugin credential scoping),
// so provide it here too — with no tools registered, nothing ever reads from it.
// Task 11: include a ProviderRegistry stub (empty pool) so ChatService.Live's new
// ProviderRegistry requirement is satisfied without touching every individual test.
const EmptyToolsLayer = Layer.mergeAll(
  ToolRegistry.Live.pipe(
    Layer.provide(ToolSource.empty),
    Layer.provide(CredentialStore.Live),
    Layer.provide(ConfigStub),
  ),
  SafeExecution.Live.pipe(
    Layer.provide(PendingConfirmations.Live),
    Layer.provide(PermissionOverlay.Live),
    Layer.provide(ConfigStub),
    Layer.provide(ToolSource.empty),
  ),
  Layer.succeed(
    ProviderRegistry,
    ProviderRegistry.of({ pool: Effect.succeed([]), refresh: Effect.succeed([]) }),
  ),
  MemoryStub,
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
            SafeExecution.Live.pipe(
              Layer.provide(PendingConfirmations.Live),
              Layer.provide(PermissionOverlay.Live),
              Layer.provide(ConfigStub),
              Layer.provide(ToolSource.empty),
            ),
            Layer.succeed(
              ProviderRegistry,
              ProviderRegistry.of({ pool: Effect.succeed([]), refresh: Effect.succeed([]) }),
            ),
            MemoryStub,
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
            SafeExecution.Live.pipe(
              Layer.provide(PendingConfirmations.Live),
              Layer.provide(PermissionOverlay.Live),
              Layer.provide(ConfigStub),
              Layer.provide(ToolSource.empty),
            ),
            Layer.succeed(
              ProviderRegistry,
              ProviderRegistry.of({ pool: Effect.succeed([]), refresh: Effect.succeed([]) }),
            ),
            MemoryStub,
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
            SafeExecution.Live.pipe(
              Layer.provideMerge(PendingConfirmations.Live),
              Layer.provide(PermissionOverlay.Live),
              Layer.provide(ConfigStub),
              Layer.provide(ToolSource.empty),
            ),
            Layer.succeed(
              ProviderRegistry,
              ProviderRegistry.of({ pool: Effect.succeed([]), refresh: Effect.succeed([]) }),
            ),
            MemoryStub,
          ),
        ),
      ),
    ),
  )
})

// REGRESSION (streaming delivery): confirm_required must reach the consumer WHILE the loop
// is blocked awaiting the decision — not buffered until the block ends. The original
// Stream.asyncEffect made the loop the pull-driver, so a blocking confirm froze delivery of
// every emitted chunk until timeout (proven: an item emitted before a 3s block was delivered
// at 3007ms), making confirm-tier tools un-confirmable over the live stream. Unlike the test
// above (which resolves the known id 'k1' directly, so it passed even with the bug), this
// OBSERVES the chunk from the stream BEFORE resolving — it fails on the buffering regression.
it.live(
  'delivers confirm_required to the consumer BEFORE the decision (no block-buffering)',
  () => {
    const { counter, layer: RegistryStub } = confirmRegistry()
    return Effect.gen(function* () {
      const pc = yield* PendingConfirmations
      const chat = yield* ChatService
      const { stream } = yield* chat.send({ message: 'do the danger thing' })

      // Consume in a forked fiber, recording chunks as they ARRIVE (not at stream end).
      const seen: { type: string }[] = []
      const fiber = yield* Stream.runForEach(stream, (c) =>
        Effect.sync(() => void seen.push(c)),
      ).pipe(Effect.fork)

      // Give the producer time to reach the confirm gate and emit. We do NOT resolve yet:
      // with the old asyncEffect the chunk would still be buffered (absent) at this point.
      yield* Effect.sleep('200 millis')
      expect(seen.some((c) => c.type === 'confirm_required')).toBe(true)
      expect(counter.executed).toBe(0) // the gate holds — the tool has NOT run yet

      // Approve; the loop unblocks, the tool runs, turn 2 streams content, the stream ends.
      yield* pc.resolve('k1', true)
      yield* Fiber.join(fiber)
      expect(seen.some((c) => c.type === 'content')).toBe(true)
      expect(counter.executed).toBe(1)
    }).pipe(
      Effect.provide(
        ChatService.Live.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ConfigStub,
              ThreadStub,
              scriptedLlm([
                [
                  { type: 'tool_call', toolCall: { id: 'k1', name: 'danger', arguments: '{}' } },
                  { type: 'finish', reason: 'tool_calls' },
                ],
                [
                  { type: 'content', content: 'done the danger thing' },
                  { type: 'finish', reason: 'stop' },
                ],
              ]),
              RegistryStub,
              SafeExecution.Live.pipe(
                Layer.provideMerge(PendingConfirmations.Live),
                Layer.provide(PermissionOverlay.Live),
                Layer.provide(ConfigStub),
                Layer.provide(ToolSource.empty),
              ),
              Layer.succeed(
                ProviderRegistry,
                ProviderRegistry.of({ pool: Effect.succeed([]), refresh: Effect.succeed([]) }),
              ),
              MemoryStub,
            ),
          ),
        ),
      ),
    )
  },
)

// ---------------------------------------------------------------------------
// Native multimodal: image referenced + frontdesk can see → attach inline
// ---------------------------------------------------------------------------

// A cloud vision frontdesk (gpt-4o) makes capabilitiesFor return vision WITHOUT an /api/show
// fetch, so this exercises the orchestration with no network.
const captureLlm = (sink: { msgs: ChatMessage[] }) =>
  Layer.succeed(
    LlmClient,
    LlmClient.of({
      chat: (messages) => {
        sink.msgs = messages
        return Stream.fromIterable([
          { type: 'content', content: 'ok' } as const,
          { type: 'finish', reason: 'stop' } as const,
        ])
      },
      isAvailable: () => Effect.succeed(true),
      detectCapabilities: () =>
        Effect.succeed({ tools: true, vision: true, audio: false, realtime: false }),
    }),
  )

const tmpImage = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-'))
  const p = join(dir, 'pic.png')
  writeFileSync(p, Buffer.from([1, 2, 3]))
  return p
}
const cfgWithFrontdesk = (provider: string, model: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'mmcfg-')), 'config.yaml')
  writeFileSync(path, `models:\n  frontdesk: { provider: ${provider}, model: ${model} }\n`)
  return Config.Live(path)
}

it.effect('attaches an image inline when the message references one + frontdesk can see', () => {
  const img = tmpImage()
  const sink = { msgs: [] as ChatMessage[] }
  return Effect.gen(function* () {
    const chat = yield* ChatService
    const { stream } = yield* chat.send({ message: `check ${img}` })
    yield* Stream.runDrain(stream)
    const last = sink.msgs[sink.msgs.length - 1]
    expect(last?.images?.length).toBe(1)
    expect(last?.images?.[0]).toMatch(/^data:image\/png;base64,/)
  }).pipe(
    Effect.provide(
      ChatService.Live.pipe(
        Layer.provide(
          Layer.mergeAll(
            cfgWithFrontdesk('openai', 'gpt-4o'),
            ThreadStub,
            captureLlm(sink),
            EmptyToolsLayer,
          ),
        ),
      ),
    ),
  )
})

it.effect('does NOT attach when the frontdesk is text-only (falls back to askVision)', () => {
  const img = tmpImage()
  const sink = { msgs: [] as ChatMessage[] }
  return Effect.gen(function* () {
    const chat = yield* ChatService
    const { stream } = yield* chat.send({ message: `check ${img}` })
    yield* Stream.runDrain(stream)
    expect(sink.msgs[sink.msgs.length - 1]?.images).toBeUndefined()
  }).pipe(
    Effect.provide(
      ChatService.Live.pipe(
        Layer.provide(
          Layer.mergeAll(
            cfgWithFrontdesk('deepseek', 'deepseek-v4-flash'),
            ThreadStub,
            captureLlm(sink),
            EmptyToolsLayer,
          ),
        ),
      ),
    ),
  )
})
