export interface ToolCallFragment {
  index: number
  id?: string
  name?: string
  argsDelta?: string
}
export interface OpenAiDelta {
  content?: string
  thinking?: string
  toolCalls?: ToolCallFragment[]
  finishReason?: 'stop' | 'length' | 'tool_calls'
  usage?: { prompt: number; completion: number }
}

interface RawChunk {
  choices?: {
    delta?: {
      content?: string
      reasoning_content?: string
      reasoning?: string
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

const FINISH = new Set(['stop', 'length', 'tool_calls'])

/** Parse ONE OpenAI-compatible SSE data payload (the JSON after `data: `, never `[DONE]`)
 *  into a normalized delta. Returns null on malformed input (degrade-don't-die). */
export const parseOpenAiData = (payload: string): OpenAiDelta | null => {
  let raw: RawChunk
  try {
    raw = JSON.parse(payload) as RawChunk
  } catch {
    return null
  }
  const out: OpenAiDelta = {}
  const choice = raw.choices?.[0]
  const delta = choice?.delta
  if (delta?.content) out.content = delta.content
  const thinking = delta?.reasoning_content ?? delta?.reasoning
  if (thinking) out.thinking = thinking
  if (delta?.tool_calls?.length) {
    out.toolCalls = delta.tool_calls.map((t, i) => ({
      index: t.index ?? i,
      ...(t.id ? { id: t.id } : {}),
      ...(t.function?.name ? { name: t.function.name } : {}),
      ...(t.function?.arguments ? { argsDelta: t.function.arguments } : {}),
    }))
  }
  if (choice?.finish_reason && FINISH.has(choice.finish_reason)) {
    out.finishReason = choice.finish_reason as OpenAiDelta['finishReason']
  }
  if (raw.usage) {
    out.usage = {
      prompt: raw.usage.prompt_tokens ?? 0,
      completion: raw.usage.completion_tokens ?? 0,
    }
  }
  return Object.keys(out).length === 0 ? null : out
}

import type { StreamChunk } from './stream-chunk'

export interface FoldState {
  // index → accumulating tool call
  readonly toolCalls: ReadonlyMap<number, { id: string; name: string; args: string }>
}
export const emptyFoldState = (): FoldState => ({ toolCalls: new Map() })

/** Reduce one normalized delta into [next state, chunks to emit]. Pure. */
export const foldDelta = (
  state: FoldState,
  delta: OpenAiDelta,
): readonly [FoldState, StreamChunk[]] => {
  const chunks: StreamChunk[] = []
  let toolCalls = state.toolCalls

  if (delta.thinking) chunks.push({ type: 'thinking', content: delta.thinking })
  if (delta.content) chunks.push({ type: 'content', content: delta.content })
  if (delta.usage)
    chunks.push({
      type: 'usage',
      promptTokens: delta.usage.prompt,
      completionTokens: delta.usage.completion,
    })

  if (delta.toolCalls?.length) {
    const next = new Map(toolCalls)
    for (const frag of delta.toolCalls) {
      const cur = next.get(frag.index) ?? { id: '', name: '', args: '' }
      next.set(frag.index, {
        id: frag.id ?? cur.id,
        name: frag.name ?? cur.name,
        args: cur.args + (frag.argsDelta ?? ''),
      })
    }
    toolCalls = next
  }

  if (delta.finishReason) {
    // flush accumulated tool calls in index order, then the finish marker
    for (const [, tc] of [...toolCalls].sort((a, b) => a[0] - b[0])) {
      chunks.push({ type: 'tool_call', toolCall: { id: tc.id, name: tc.name, arguments: tc.args } })
    }
    chunks.push({ type: 'finish', reason: delta.finishReason })
    toolCalls = new Map()
  }

  return [{ toolCalls }, chunks]
}
