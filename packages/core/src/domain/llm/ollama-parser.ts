import { Effect } from 'effect'
import { randomUUID } from 'node:crypto'
import type { StreamChunk } from './stream-chunk'

interface OllamaLine {
  message?: {
    content?: string
    thinking?: string
    tool_calls?: { function?: { name?: string; arguments?: Record<string, unknown> } }[]
  }
  done?: boolean
}

/** Parse one Ollama /api/chat NDJSON line → chunk | null. Never fails (degrade-don't-die). */
export const parseOllamaLine = (line: string): Effect.Effect<StreamChunk | null> =>
  Effect.sync<StreamChunk | null>(() => {
    const json = JSON.parse(line) as OllamaLine
    const call = json.message?.tool_calls?.[0]?.function
    if (call?.name) {
      return {
        type: 'tool_call',
        toolCall: {
          id: randomUUID(),
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        },
      }
    }
    if (json.message?.thinking) return { type: 'thinking', content: json.message.thinking }
    if (json.message?.content) return { type: 'content', content: json.message.content }
    if (json.done) return { type: 'finish', reason: 'stop' }
    return null
  }).pipe(Effect.catchAllCause(() => Effect.succeed(null)))
