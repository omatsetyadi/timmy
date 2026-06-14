import { Context, Effect, Layer, Option, Stream } from 'effect'
import { NetworkError, type LlmError } from './errors'
import { parseOllamaLine } from './ollama-parser'
import type { StreamChunk } from './stream-chunk'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
export interface DetectedCapabilities {
  vision: boolean
  audio: boolean
  tools: boolean
  realtime: boolean
}
export interface LlmConfig {
  baseUrl: string
  model: string
}

export class LlmClient extends Context.Tag('timmy/llm/client')<
  LlmClient,
  {
    readonly chat: (messages: ChatMessage[]) => Stream.Stream<StreamChunk, LlmError>
    readonly isAvailable: () => Effect.Effect<boolean>
    readonly detectCapabilities: () => Effect.Effect<DetectedCapabilities>
  }
>() {
  static Live = (config: LlmConfig) =>
    Layer.succeed(LlmClient, {
      chat: (messages) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const res = yield* Effect.tryPromise({
              try: () =>
                fetch(`${config.baseUrl}/api/chat`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    model: config.model,
                    messages,
                    stream: true,
                    think: false,
                  }),
                }),
              catch: (e) => new NetworkError({ message: 'ollama request failed', cause: e }),
            })
            if (!res.ok || !res.body)
              return Stream.fail(new NetworkError({ message: `ollama ${res.status}` }))
            return Stream.fromReadableStream(
              () => res.body!,
              (e) => new NetworkError({ message: 'stream read failed', cause: e }),
            ).pipe(
              Stream.decodeText('utf-8'),
              Stream.splitLines,
              Stream.mapEffect((line) => parseOllamaLine(line.trim())),
              Stream.filterMap((c) => (c ? Option.some(c) : Option.none())),
            )
          }),
        ),
      isAvailable: () =>
        Effect.tryPromise(() => fetch(`${config.baseUrl}/api/tags`)).pipe(
          Effect.map((r) => r.ok),
          Effect.catchAll(() => Effect.succeed(false)),
        ),
      detectCapabilities: () =>
        Effect.tryPromise(() =>
          fetch(`${config.baseUrl}/api/show`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: config.model }),
          }).then((r) => r.json() as Promise<{ capabilities?: string[] }>),
        ).pipe(
          Effect.map((d) => ({
            tools: (d.capabilities ?? []).includes('tools'),
            vision: (d.capabilities ?? []).includes('vision'),
            audio: false,
            realtime: false,
          })),
          Effect.catchAll(() =>
            Effect.succeed({ tools: false, vision: false, audio: false, realtime: false }),
          ),
        ),
    })
}
