import type { ChatFrame } from './frames'

export type TurnPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'memory'; entities: string[] }
  | { type: 'error'; message: string }
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

/** Turn a raw provider/stream error into an actionable one-liner by appending a hint for the common
 *  HTTP statuses. Pure — the status is sniffed from the message text (errors arrive as plain strings).
 *  Unrecognized messages pass through unchanged so we never hide the original. */
export function friendlyError(message: string): string {
  const hint = /\b(401|403)\b/.test(message)
    ? 'check your API key (`timmy model set-key <provider>`)'
    : /\b404\b/.test(message)
      ? 'check the model name / provider in `timmy model status`'
      : /\b429\b/.test(message)
        ? "rate limited — wait a moment, or you've hit the provider's quota"
        : ''
  return hint ? `${message} — ${hint}` : message
}

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
    case 'memory':
      return { ...s, parts: [...s.parts, { type: 'memory', entities: f.entities }] }
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
      // An error chunk must NEVER be silently dropped — surface it as a visible part so a provider
      // 404/401/rate-limit shows up plainly instead of an empty "no response" turn.
      if (f.chunk.type === 'error')
        return { ...s, parts: [...s.parts, { type: 'error', message: f.chunk.message }] }
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
