export interface ToolCallChunk {
  id: string
  name: string
  arguments: string
}
/** UI hint on a confirm chunk: what an "always allow" would persist, and a human label for it. */
export type AlwaysHint = { scope: 'command' | 'tool'; label: string }
export type StreamChunk =
  | { type: 'content'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; toolCall: ToolCallChunk } // shape defined; unused until Phase 3
  | { type: 'confirm_required'; id: string; tool: string; description: string; always: AlwaysHint }
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool_calls' }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'memory_recall'; entities: string[] }
  | { type: 'error'; message: string }
