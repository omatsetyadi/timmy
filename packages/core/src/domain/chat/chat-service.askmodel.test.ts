import { it } from '@effect/vitest'
import { Effect, Layer, Stream } from 'effect'
import { expect } from 'vitest'
import type { Tool } from 'timmy-sdk'
import { ChatService } from './chat-service'
import { LlmClient } from '../llm/llm-client'
import { ToolSource } from '../tools/tool-source'
import { ToolRegistry } from '../tools/tool-registry'
import { SafeExecution } from '../tools/safe-execution'
import { PendingConfirmations } from '../tools/confirmations'
import { PermissionOverlay } from '../tools/permission-overlay'
import { Config } from '../config/config'
import { CredentialStore } from '../credentials/credential-store'
import { ProviderRegistry } from '../llm/provider-registry'
import { ThreadStore } from '../persistence/thread-store'
import type { StreamChunk } from '../llm/stream-chunk'

// ---------------------------------------------------------------------------
// Task 16 Step 1 — askModel integration test
//
// Asserts: the chat loop calls askModel when the model requests it and the
// result (turn-2 content containing "42") reaches the consumer.
// ---------------------------------------------------------------------------

const ConfigStub = Config.Live(`${process.cwd()}/__nope__.yaml`) // defaults

const ThreadStub = Layer.succeed(
  ThreadStore,
  ThreadStore.of({
    createThread: () => Effect.succeed('t-askmodel'),
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

// Scripted LLM: turn 1 → tool_call askModel; turn 2 → content with "42".
const makeAskModelLlm = () => {
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
              toolCall: { id: 't1', name: 'askModel', arguments: '{"prompt":"hard question"}' },
            },
            { type: 'finish', reason: 'tool_calls' },
          ])
        }
        return Stream.fromIterable<StreamChunk>([
          { type: 'content', content: 'Timmy says: 42' },
          { type: 'finish', reason: 'stop' },
        ])
      },
      isAvailable: () => Effect.succeed(true),
      detectCapabilities: () =>
        Effect.succeed({ tools: true, vision: false, audio: false, realtime: false }),
    }),
  )
}

// Canned askModel tool — safe tier, returns { text: '42', target: 'deepseek/deepseek-v4-flash' }.
const askModelTool: Tool = {
  name: 'askModel',
  description: 'Consult a reasoning model',
  parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
  riskLevel: 'safe',
  execute: async () => ({ ok: true, data: { text: '42', target: 'deepseek/deepseek-v4-flash' } }),
}

it.live('frontdesk calls askModel and answers using the result', () => {
  const StubLlm = makeAskModelLlm()
  return Effect.gen(function* () {
    const chat = yield* ChatService
    const { stream } = yield* chat.send({ message: 'think hard' })
    const chunks = [...(yield* Stream.runCollect(stream))]
    // turn-2 content must contain "42" — the value askModel returned
    expect(
      chunks.some((c) => c.type === 'content' && 'content' in c && c.content.includes('42')),
    ).toBe(true)
  }).pipe(
    Effect.provide(
      ChatService.Live.pipe(
        Layer.provide(
          Layer.mergeAll(
            ConfigStub,
            ThreadStub,
            StubLlm,
            ProviderRegistryStub,
            ToolRegistry.Live.pipe(
              Layer.provide(ToolSource.layer([askModelTool])),
              Layer.provide(CredentialStore.Live),
              Layer.provide(ConfigStub),
            ),
            SafeExecution.Live.pipe(
              Layer.provide(PendingConfirmations.Live),
              Layer.provide(PermissionOverlay.Live),
              Layer.provide(ConfigStub),
              Layer.provide(ToolSource.empty),
            ),
          ),
        ),
      ),
    ),
  )
})
