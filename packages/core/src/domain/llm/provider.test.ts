import { it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import { describe, expect, it as itV, vi, afterEach } from 'vitest'
import { makeProvider, toOpenAiMessages } from './provider'
import type { ChatMessage } from './llm-client'
import type { StreamChunk } from './stream-chunk'

afterEach(() => vi.restoreAllMocks())

describe('toOpenAiMessages (strict tool-call wire format)', () => {
  itV('maps an assistant tool_calls turn + a tool result to the OpenAI shape', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', name: 'askModel', arguments: '{"prompt":"q"}' }],
      },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_1' },
    ]
    expect(toOpenAiMessages(msgs)).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'askModel', arguments: '{"prompt":"q"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ])
  })
})

// Build a Response whose body streams the given SSE lines.
const sseResponse = (lines: string[]): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder()
      for (const l of lines) c.enqueue(enc.encode(l + '\n'))
      c.close()
    },
  })
  return new Response(body, { status: 200 })
}

it.effect('openai-compat client streams content + finish from SSE', () =>
  Effect.gen(function* () {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
        'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]',
      ]),
    )
    const client = makeProvider({
      providerKey: 'deepseek',
      kind: 'openai-compat',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
    })
    const chunks: StreamChunk[] = yield* Stream.runCollect(
      client.chat([{ role: 'user', content: 'hi' }]),
    ).pipe(Effect.map((c) => [...c]))
    expect(chunks).toEqual([
      { type: 'content', content: 'Hello' },
      { type: 'finish', reason: 'stop' },
    ])
  }),
)

it.effect('openai-compat 401 → fails with AuthError', () =>
  Effect.gen(function* () {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }))
    const client = makeProvider({
      providerKey: 'openai',
      kind: 'openai-compat',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'bad',
    })
    const exit = yield* Stream.runDrain(client.chat([{ role: 'user', content: 'hi' }])).pipe(
      Effect.flip,
    )
    expect(exit._tag).toBe('timmy/llm/AuthError')
  }),
)

it.effect('detectCapabilities uses the static map for openai-compat', () =>
  Effect.gen(function* () {
    const client = makeProvider({
      providerKey: 'anthropic',
      kind: 'openai-compat',
      model: 'claude-sonnet-4-6',
      baseUrl: 'x',
      apiKey: 'k',
    })
    expect(yield* client.detectCapabilities()).toEqual({
      vision: true,
      audio: false,
      tools: true,
      realtime: false,
    })
  }),
)
