export interface ToolCallChunk {
  id: string
  name: string
  arguments: string
}
export type StreamChunk =
  | { type: 'content'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; toolCall: ToolCallChunk } // shape defined; unused until Phase 3
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool_calls' }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'error'; message: string }
