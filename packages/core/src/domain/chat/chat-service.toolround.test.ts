import { it } from '@effect/vitest'
import { Effect, Layer, Stream } from 'effect'
import { expect } from 'vitest'
import type { Tool } from 'timmy-sdk'
import { ChatService } from './chat-service'
import { LlmClient, type ChatMessage } from '../llm/llm-client'
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
// Regression: after a tool call, the loop must feed results back as a PROPER
// tool round — an assistant message carrying tool_calls, then a tool message
// with a matching tool_call_id. The old `[tool_call X]` + bare `{role:'tool'}`
// form is rejected by strict cloud APIs (DeepSeek/OpenAI) with HTTP 400.
// ---------------------------------------------------------------------------

const ConfigStub = Config.Live(`${process.cwd()}/__nope__.yaml`)
const ThreadStub = Layer.succeed(
  ThreadStore,
  ThreadStore.of({
    createThread: () => Effect.succeed('t-round'),
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

const askModelTool: Tool = {
  name: 'askModel',
  description: 'Consult a reasoning model',
  parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
  riskLevel: 'safe',
  execute: async () => ({ ok: true, data: { text: '42' } }),
}

it.live(
  'feeds tool results back as a valid tool round (assistant tool_calls + tool_call_id)',
  () => {
    let turn = 0
    let turn2: ChatMessage[] = []
    const StubLlm = Layer.succeed(
      LlmClient,
      LlmClient.of({
        chat: (messages) => {
          turn += 1
          if (turn === 1) {
            return Stream.fromIterable<StreamChunk>([
              {
                type: 'tool_call',
                toolCall: { id: 'call_abc', name: 'askModel', arguments: '{"prompt":"q"}' },
              },
              { type: 'finish', reason: 'tool_calls' },
            ])
          }
          turn2 = messages as ChatMessage[] // capture what the loop sends on the follow-up turn
          return Stream.fromIterable<StreamChunk>([
            { type: 'content', content: 'done' },
            { type: 'finish', reason: 'stop' },
          ])
        },
        isAvailable: () => Effect.succeed(true),
        detectCapabilities: () =>
          Effect.succeed({ tools: true, vision: false, audio: false, realtime: false }),
      }),
    )

    return Effect.gen(function* () {
      const chat = yield* ChatService
      const { stream } = yield* chat.send({ message: 'go' })
      yield* Stream.runDrain(stream)

      const assistant = turn2.find((m) => m.role === 'assistant' && m.tool_calls?.length)
      expect(assistant?.tool_calls?.[0]).toEqual({
        id: 'call_abc',
        name: 'askModel',
        arguments: '{"prompt":"q"}',
      })

      const toolMsg = turn2.find((m) => m.role === 'tool')
      expect(toolMsg?.tool_call_id).toBe('call_abc')
      // the legacy malformed marker must be gone
      expect(turn2.some((m) => m.content.includes('[tool_call'))).toBe(false)
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
  },
)
