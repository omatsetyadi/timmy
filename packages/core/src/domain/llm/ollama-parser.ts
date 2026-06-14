import { Effect } from 'effect'
import type { StreamChunk } from './stream-chunk'

interface OllamaLine {
  message?: { content?: string; thinking?: string }
  done?: boolean
}

/** Parse one Ollama /api/chat NDJSON line → chunk | null. Never fails (degrade-don't-die). */
export const parseOllamaLine = (line: string): Effect.Effect<StreamChunk | null> =>
  Effect.sync<StreamChunk | null>(() => {
    const json = JSON.parse(line) as OllamaLine
    if (json.message?.thinking) return { type: 'thinking', content: json.message.thinking }
    if (json.message?.content) return { type: 'content', content: json.message.content }
    if (json.done) return { type: 'finish', reason: 'stop' }
    return null
  }).pipe(Effect.catchAllCause(() => Effect.succeed(null)))
