import type { TimmyConfig } from '../config/config'
import type { MessageRow } from '../persistence/thread-store'
import type { ChatMessage } from '../llm/llm-client'

export function buildSystemPrompt(
  config: TimmyConfig,
  reasoningTargets: readonly string[] = [],
  claudeAvailable = false,
): string {
  const a = config.assistant
  let p = a.personality.trim()
  p +=
    a.language.conversation === 'auto'
      ? '\n\nReply in the same language the user writes in. If they switch, switch with them.'
      : `\n\nReply in ${a.language.conversation}.`
  if (reasoningTargets.length > 0) {
    p +=
      `\n\nFor reasoning beyond your own depth you can call the askModel tool to consult a stronger model, ` +
      `then answer the user yourself in your own voice. Available targets: ${reasoningTargets.join(', ')}.`
  }
  if (claudeAvailable) {
    p +=
      `\n\nFor tasks you cannot do with your own tools (running bash/docker, preparing a DB, making a ticket PR-ready), ` +
      `call the askClaude tool: Claude Code executes the task with its own tools and reports back. ` +
      `askClaude DOES work; askModel only reasons.`
  }
  return p
}

export function buildMessages(
  config: TimmyConfig,
  history: MessageRow[],
  userMessage: string,
  reasoningTargets: readonly string[] = [],
  claudeAvailable = false,
): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(config, reasoningTargets, claudeAvailable) },
  ]
  for (const m of history) msgs.push({ role: m.role as ChatMessage['role'], content: m.content })
  msgs.push({ role: 'user', content: userMessage })
  return msgs
}
