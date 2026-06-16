import type { TimmyConfig } from '../config/config'
import type { MessageRow } from '../persistence/thread-store'
import type { ChatMessage } from '../llm/llm-client'

export function buildSystemPrompt(
  config: TimmyConfig,
  reasoningTargets: readonly string[] = [],
  claudeAvailable = false,
  memoryBlock = '',
): string {
  const a = config.assistant
  const u = config.user
  // Identity comes from config (CLI-editable), not baked into the personality string.
  let p = `You are ${a.name}, a personal AI assistant.\n\n${a.personality.trim()}`
  // User-authored response style: a behavior instruction, so it sits with the other behavior rules.
  const style = u?.style?.trim()
  if (style) p += `\n\nHow to respond to this user (their preference): ${style}`
  p +=
    a.language.conversation === 'auto'
      ? '\n\nReply in the same language the user writes in. If they switch, switch with them.'
      : `\n\nReply in ${a.language.conversation}.`
  // The direct path: cheap, instant, no extra model. Always available.
  p +=
    `\n\nYou can run shell commands directly with the runCommand tool — prefer it for quick OS/dev tasks ` +
    `(checking status, listing files, git, docker). Dangerous commands will ask the user to confirm first. ` +
    `Use the cheapest capable tool: never reach for a heavier tool to do something a direct command answers.`
  if (reasoningTargets.length > 0) {
    p +=
      `\n\nFor reasoning beyond your own depth you can call the askModel tool to consult a stronger model, ` +
      `then answer the user yourself in your own voice. Available targets: ${reasoningTargets.join(', ')}.`
  }
  if (claudeAvailable) {
    p +=
      `\n\nFor HEAVY, multi-step, code-related work (refactors, building a feature, complex DB/docker setup, making a ticket PR-ready), ` +
      `call the askClaude tool: Claude Code executes the task with its own tools and reports back. ` +
      `askClaude DOES work; askModel only reasons. Don't use askClaude for something runCommand can do in one command.`
  }
  // User-authored "about me": grounding the user wrote themselves (name + bio). Placed after the
  // behavioral instructions and BEFORE the auto-learned memory block, so the user's own words lead.
  const userName = u?.name?.trim()
  const about = u?.about?.trim()
  if (userName || about) {
    const namePart = userName ? `Their name is ${userName}.` : ''
    p += `\n\nAbout the user: ${[namePart, about].filter(Boolean).join(' ')}`
  }
  // Recalled memory subgraph ("What you know about the user"): appended last so it reads as
  // grounding context after the behavioral instructions. Empty block = no append.
  if (memoryBlock.trim()) {
    p += `\n\n${memoryBlock.trim()}`
  }
  return p
}

export function buildMessages(
  config: TimmyConfig,
  history: MessageRow[],
  userMessage: string,
  reasoningTargets: readonly string[] = [],
  claudeAvailable = false,
  memoryBlock = '',
): ChatMessage[] {
  const msgs: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(config, reasoningTargets, claudeAvailable, memoryBlock),
    },
  ]
  for (const m of history) msgs.push({ role: m.role as ChatMessage['role'], content: m.content })
  msgs.push({ role: 'user', content: userMessage })
  return msgs
}
