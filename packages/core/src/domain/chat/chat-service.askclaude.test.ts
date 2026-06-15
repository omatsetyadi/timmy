import { it } from '@effect/vitest'
import { Effect, Fiber, Layer, Stream } from 'effect'
import { expect } from 'vitest'
import type { Tool } from 'timmy-sdk'
import { ChatService } from './chat-service'
import { LlmClient } from '../llm/llm-client'
import { ToolSource } from '../tools/tool-source'
import { ToolRegistry } from '../tools/tool-registry'
import { SafeExecution } from '../tools/safe-execution'
import { PendingConfirmations } from '../tools/confirmations'
import { Config } from '../config/config'
import { CredentialStore } from '../credentials/credential-store'
import { ProviderRegistry } from '../llm/provider-registry'
import { ThreadStore } from '../persistence/thread-store'
import type { StreamChunk } from '../llm/stream-chunk'

// ---------------------------------------------------------------------------
// Task 16 Step 1b — askClaude integration test
//
// Asserts:
//   1. A confirm_required chunk is emitted mid-stream (the confirm gate fires).
//   2. After approving via PendingConfirmations.resolve(id, true), the turn-2
//      content ("Done — dev DB ready.") reaches the consumer.
// ---------------------------------------------------------------------------

const ConfigStub = Config.Live(`${process.cwd()}/__nope__.yaml`) // defaults

const ThreadStub = Layer.succeed(
  ThreadStore,
  ThreadStore.of({
    createThread: () => Effect.succeed('t-askclaude'),
    threadExists: () => Effect.succeed(true),
    addMessage: () => Effect.void,
    getMessages: () => Effect.succeed([]),
    listThreads: () => Effect.succeed([]),
    getThread: () => Effect.succeed(null),
  }),
)

const ProviderRegistryStub = Layer.succeed(
  ProviderRegistry,
  ProviderRegistry.of({ pool: Effect.succeed([]), refresh: Effect.succeed([]) }),
)

// Scripted LLM: turn 1 → tool_call askClaude (confirm-tier); turn 2 → content "Done".
const makeAskClaudeLlm = () => {
  let turn = 0
  return Layer.succeed(
    LlmClient,
    LlmClient.of({
      chat: () => {
        turn += 1
        if (turn === 1) {
          return Stream.fromIterable<StreamChunk>([
            {
              type: 'tool_call',
              toolCall: { id: 'c1', name: 'askClaude', arguments: '{"task":"make a dev db"}' },
            },
            { type: 'finish', reason: 'tool_calls' },
          ])
        }
        return Stream.fromIterable<StreamChunk>([
          { type: 'content', content: 'Done — dev DB ready.' },
          { type: 'finish', reason: 'stop' },
        ])
      },
      isAvailable: () => Effect.succeed(true),
      detectCapabilities: () =>
        Effect.succeed({ tools: true, vision: false, audio: false, realtime: false }),
    }),
  )
}

// Canned askClaude tool — confirm tier, returns agentic result.
const askClaudeTool: Tool = {
  name: 'askClaude',
  description: 'Delegate an agentic task to Claude Code',
  parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
  riskLevel: 'confirm',
  execute: async () => ({ ok: true, data: { text: 'created dev DB', actions: ['Bash'] } }),
}

it.live('askClaude is gated by confirm, then its result feeds the answer', () => {
  const StubLlm = makeAskClaudeLlm()
  return Effect.gen(function* () {
    const pc = yield* PendingConfirmations
    const chat = yield* ChatService
    const { stream } = yield* chat.send({ message: 'set up a dev db' })

    const seen: StreamChunk[] = []

    // Consume in a forked fiber; when a confirm_required chunk arrives, approve it
    // immediately via PendingConfirmations.resolve — real method name is `resolve(id, boolean)`.
    const fiber = yield* Stream.runForEach(stream, (c) =>
      Effect.gen(function* () {
        seen.push(c)
        if (c.type === 'confirm_required') {
          yield* pc.resolve(c.id, true)
        }
      }),
    ).pipe(Effect.fork)

    yield* Fiber.join(fiber)

    // Gate must have fired — a confirm_required chunk was emitted.
    expect(seen.some((c) => c.type === 'confirm_required')).toBe(true)
    // After approval, the agentic result feeds turn 2, which includes "Done".
    expect(
      seen.some((c) => c.type === 'content' && 'content' in c && c.content.includes('Done')),
    ).toBe(true)
  }).pipe(
    // Use provideMerge (not provide) so the test shares the SAME PendingConfirmations
    // instance that SafeExecution uses inside ChatService.Live.
    Effect.provide(
      ChatService.Live.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ConfigStub,
            ThreadStub,
            StubLlm,
            ProviderRegistryStub,
            ToolRegistry.Live.pipe(
              Layer.provide(ToolSource.layer([askClaudeTool])),
              Layer.provide(CredentialStore.Live),
              Layer.provide(ConfigStub),
            ),
            SafeExecution.Live.pipe(
              Layer.provideMerge(PendingConfirmations.Live),
              Layer.provide(ConfigStub),
              Layer.provide(ToolSource.empty),
            ),
          ),
        ),
      ),
    ),
  )
})

// ADDITIONAL: verify that the confirm_required chunk arrives BEFORE the resolve
// (no block-buffering regression from the existing test suite).
it.live('delivers confirm_required to consumer BEFORE the decision', () => {
  const StubLlm = makeAskClaudeLlm()
  return Effect.gen(function* () {
    const pc = yield* PendingConfirmations
    const chat = yield* ChatService
    const { stream } = yield* chat.send({ message: 'set up a dev db' })

    const seen: StreamChunk[] = []
    const fiber = yield* Stream.runForEach(stream, (c) =>
      Effect.sync(() => void seen.push(c)),
    ).pipe(Effect.fork)

    // Give the producer time to reach the confirm gate and emit.
    yield* Effect.sleep('200 millis')

    // confirm_required must already be visible before we resolve.
    expect(seen.some((c) => c.type === 'confirm_required')).toBe(true)

    // Approve the pending confirm to unblock the loop.
    const confirmChunk = seen.find((c) => c.type === 'confirm_required')
    if (confirmChunk && confirmChunk.type === 'confirm_required') {
      yield* pc.resolve(confirmChunk.id, true)
    }

    yield* Fiber.join(fiber)

    // Turn-2 content must arrive after approval.
    expect(
      seen.some((c) => c.type === 'content' && 'content' in c && c.content.includes('Done')),
    ).toBe(true)
  }).pipe(
    Effect.provide(
      ChatService.Live.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ConfigStub,
            ThreadStub,
            StubLlm,
            ProviderRegistryStub,
            ToolRegistry.Live.pipe(
              Layer.provide(ToolSource.layer([askClaudeTool])),
              Layer.provide(CredentialStore.Live),
              Layer.provide(ConfigStub),
            ),
            SafeExecution.Live.pipe(
              Layer.provideMerge(PendingConfirmations.Live),
              Layer.provide(ConfigStub),
              Layer.provide(ToolSource.empty),
            ),
          ),
        ),
      ),
    ),
  )
})
