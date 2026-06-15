import { Context, Effect, Layer, Option, Stream } from 'effect'
import { NetworkError, type LlmError } from './errors'
import { parseOllamaLine } from './ollama-parser'
import type { StreamChunk } from './stream-chunk'

export interface ToolCallRef {
  id: string
  name: string
  arguments: string // JSON-encoded arguments
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Present on an assistant turn that invoked tools (OpenAI/Ollama tool-calling). */
  tool_calls?: ToolCallRef[]
  /** Present on a tool-result message; references the assistant tool_call it answers. */
  tool_call_id?: string
  /** Inline images (data URLs: `data:<mime>;base64,<...>`) for a multimodal model to see
   *  directly. Attached to the request only — never persisted to thread history. */
  images?: string[]
}

/** Strip a data-URL prefix to the raw base64 Ollama's `images[]` wants. */
const toRawBase64 = (dataUrl: string): string => dataUrl.replace(/^data:[^;]+;base64,/, '')

const safeJsonObject = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Map our canonical ChatMessage[] to Ollama's /api/chat wire shape: an assistant turn's
 *  tool calls become `{ function: { name, arguments: <object> } }` (Ollama wants an object,
 *  not a JSON string); tool results are `{ role:'tool', content }`. */
export const toOllamaMessages = (messages: ChatMessage[]): unknown[] =>
  messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.tool_calls.map((tc) => ({
          function: { name: tc.name, arguments: safeJsonObject(tc.arguments) },
        })),
      }
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content }
    // Ollama /api/chat takes images as raw base64 in an `images` array on the message.
    if (m.images?.length) {
      return { role: m.role, content: m.content, images: m.images.map(toRawBase64) }
    }
    return { role: m.role, content: m.content }
  })
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
    readonly chat: (
      messages: ChatMessage[],
      tools?: unknown[],
    ) => Stream.Stream<StreamChunk, LlmError>
    readonly isAvailable: () => Effect.Effect<boolean>
    readonly detectCapabilities: () => Effect.Effect<DetectedCapabilities>
  }
>() {
  static Live = (config: LlmConfig) => Layer.succeed(LlmClient, makeOllamaClient(config))
}

/** Build the Ollama (NDJSON) implementation of the LlmClient service interface. */
export const makeOllamaClient = (config: LlmConfig): Context.Tag.Service<LlmClient> => ({
  chat: (messages, tools) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () =>
            fetch(`${config.baseUrl}/api/chat`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                model: config.model,
                messages: toOllamaMessages(messages),
                tools,
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
        body: JSON.stringify({ name: config.model, model: config.model }),
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
