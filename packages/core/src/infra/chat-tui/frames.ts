import type { StreamChunk } from '../../domain/llm/stream-chunk'

// ── pure: NDJSON line → frame ───────────────────────────────────────────────
// The /chat stream is newline-delimited JSON: an opening {thread_id} line, then
// typed StreamChunk lines as tokens arrive, a possible {type:'confirm_required'}
// mid-stream, and a closing {done:true}. parseFrame classifies one raw line so
// the REPL shell can stay tiny and the classification stays unit-testable.

export type ChatFrame =
  | { kind: 'thread'; threadId: string }
  | { kind: 'done' }
  | {
      kind: 'confirm'
      id: string
      tool: string
      description: string
      always: { scope: 'command' | 'tool'; label: string }
    }
  | { kind: 'memory'; entities: string[] }
  | { kind: 'chunk'; chunk: StreamChunk }
  | { kind: 'ignore' }

export function parseFrame(line: string): ChatFrame {
  const trimmed = line.trim()
  if (trimmed === '') return { kind: 'ignore' }
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return { kind: 'ignore' }
  }
  if (typeof obj.thread_id === 'string') return { kind: 'thread', threadId: obj.thread_id }
  if (obj.done === true) return { kind: 'done' }
  if (obj.type === 'confirm_required') {
    return {
      kind: 'confirm',
      id: String(obj.id),
      tool: String(obj.tool),
      description: String(obj.description),
      always: (obj.always as { scope: 'command' | 'tool'; label: string }) ?? {
        scope: 'tool',
        label: String(obj.tool),
      },
    }
  }
  if (obj.type === 'memory_recall') {
    return {
      kind: 'memory',
      entities: Array.isArray(obj.entities) ? (obj.entities as string[]) : [],
    }
  }
  if (typeof obj.type === 'string') return { kind: 'chunk', chunk: obj as unknown as StreamChunk }
  return { kind: 'ignore' }
}

// ── pure: StreamChunk → terminal output ─────────────────────────────────────
export const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`
export const red = (s: string): string => `\x1b[31m${s}\x1b[0m`
export const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`

export interface RenderOpts {
  showThinking?: boolean
}

/** Map ONE StreamChunk to the string to write to stdout. '' = render nothing.
 *  `confirm_required` is handled interactively by the shell, never here. */
export function renderChunk(chunk: StreamChunk, opts: RenderOpts = {}): string {
  switch (chunk.type) {
    case 'content':
      return chunk.content
    case 'thinking':
      return opts.showThinking ? dim(chunk.content) : ''
    case 'tool_call':
      return cyan(`\n→ ${chunk.toolCall.name}\n`)
    case 'usage':
      return dim(`\n[tokens: ${chunk.promptTokens}+${chunk.completionTokens}]`)
    case 'error':
      return red(`\n✗ ${chunk.message}\n`)
    case 'finish':
    case 'confirm_required':
    case 'memory_recall':
      return ''
  }
}
