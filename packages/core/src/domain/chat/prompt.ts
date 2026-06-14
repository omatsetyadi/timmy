import type { TimmyConfig } from '../config/config'
import type { MessageRow } from '../persistence/thread-store'
import type { ChatMessage } from '../llm/llm-client'

export function buildSystemPrompt(config: TimmyConfig): string {
  const a = config.assistant
  let p = a.personality.trim()
  p +=
    a.language.conversation === 'auto'
      ? '\n\nReply in the same language the user writes in. If they switch, switch with them.'
      : `\n\nReply in ${a.language.conversation}.`
  return p
}

export function buildMessages(
  config: TimmyConfig,
  history: MessageRow[],
  userMessage: string,
): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(config) }]
  for (const m of history) msgs.push({ role: m.role as ChatMessage['role'], content: m.content })
  msgs.push({ role: 'user', content: userMessage })
  return msgs
}
