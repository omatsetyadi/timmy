import { it } from '@effect/vitest'
import { Chunk, Effect, Stream } from 'effect'
import { expect, vi, afterEach } from 'vitest'
import { LlmClient } from './llm-client'

afterEach(() => vi.restoreAllMocks())

const ndjson = (lines: object[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(new TextEncoder().encode(JSON.stringify(l) + '\n'))
      c.close()
    },
  })

it.effect('streams content chunks from a mocked Ollama response', () =>
  Effect.gen(function* () {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        ndjson([
          { message: { content: 'Hi' } },
          { message: { content: ' there' } },
          { done: true },
        ]),
        { status: 200 },
      ),
    )
    const client = yield* LlmClient
    const stream = client.chat([{ role: 'user', content: 'hey' }])
    const chunks = Chunk.toArray(yield* Stream.runCollect(stream))
    expect(chunks).toEqual([
      { type: 'content', content: 'Hi' },
      { type: 'content', content: ' there' },
      { type: 'finish', reason: 'stop' },
    ])
  }).pipe(Effect.provide(LlmClient.Live({ baseUrl: 'http://x', model: 'qwen3:14b' }))),
)

it.effect('streams a tool_call when the model calls a tool', () =>
  Effect.gen(function* () {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        ndjson([
          {
            message: {
              tool_calls: [{ function: { name: 'openApp', arguments: { name: 'Spotify' } } }],
            },
          },
          { done: true },
        ]),
        { status: 200 },
      ),
    )
    const client = yield* LlmClient
    const tools = [
      { type: 'function', function: { name: 'openApp', description: 'open', parameters: {} } },
    ]
    const chunks = Chunk.toArray(
      yield* Stream.runCollect(client.chat([{ role: 'user', content: 'open spotify' }], tools)),
    )
    expect(chunks.map((c) => c.type)).toEqual(['tool_call', 'finish'])
  }).pipe(Effect.provide(LlmClient.Live({ baseUrl: 'http://x', model: 'qwen3:14b' }))),
)
