import type { ChatFrame } from './frames'

export type TurnPart = { type: 'text'; text: string } | { type: 'tool'; name: string }
export interface TranscriptItem {
  role: 'user' | 'assistant'
  parts: TurnPart[]
}
export interface ConfirmReq {
  id: string
  tool: string
  description: string
  always: { scope: 'command' | 'tool'; label: string }
}
export interface ChatState {
  threadId?: string
  transcript: TranscriptItem[]
  parts: TurnPart[] // the in-progress assistant turn, ordered (text + tool parts interleaved)
  confirm?: ConfirmReq
}

export const initialState = (): ChatState => ({ transcript: [], parts: [] })

/** Push a user message into the committed transcript (called when the user submits). */
export const withUserMessage = (s: ChatState, text: string): ChatState => ({
  ...s,
  transcript: [...s.transcript, { role: 'user', parts: [{ type: 'text', text }] }],
})

/** Fold one stream frame into UI state. Pure. */
export function reduceFrame(s: ChatState, f: ChatFrame): ChatState {
  switch (f.kind) {
    case 'thread':
      return { ...s, threadId: f.threadId }
    case 'confirm':
      return {
        ...s,
        confirm: { id: f.id, tool: f.tool, description: f.description, always: f.always },
      }
    case 'chunk':
      if (f.chunk.type === 'content') {
        const last = s.parts[s.parts.length - 1]
        const parts: TurnPart[] =
          last && last.type === 'text'
            ? [...s.parts.slice(0, -1), { type: 'text', text: last.text + f.chunk.content }]
            : [...s.parts, { type: 'text', text: f.chunk.content }]
        return { ...s, parts }
      }
      if (f.chunk.type === 'tool_call')
        return { ...s, parts: [...s.parts, { type: 'tool', name: f.chunk.toolCall.name }] }
      return s
    case 'done':
      return {
        ...s,
        transcript: s.parts.length
          ? [...s.transcript, { role: 'assistant', parts: s.parts }]
          : s.transcript,
        parts: [],
      }
    case 'ignore':
      return s
  }
}
