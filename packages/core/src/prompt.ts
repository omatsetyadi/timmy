import type { Message } from 'timmy-sdk'
import type { TimmyConfig } from './config'
import type { MessageRow } from './db'

/**
 * Compose the system prompt: personality first, then language behaviour.
 * (Entity memory + RAG chunks get layered in here in later phases.)
 */
export function buildSystemPrompt(config: TimmyConfig): string {
  const a = config.assistant
  let prompt = a.personality.trim()
  if (a.language.conversation === 'auto') {
    prompt +=
      '\n\nReply in the same language the user writes in. If they switch languages, switch with them.'
  } else {
    prompt += `\n\nReply in ${a.language.conversation}.`
  }
  return prompt
}

/** Build the full message list for a chat turn: system + history + new user message. */
export function buildMessages(
  config: TimmyConfig,
  history: MessageRow[],
  userMessage: string,
): Message[] {
  const messages: Message[] = [{ role: 'system', content: buildSystemPrompt(config) }]
  for (const m of history) {
    messages.push({ role: m.role as Message['role'], content: m.content })
  }
  messages.push({ role: 'user', content: userMessage })
  return messages
}
