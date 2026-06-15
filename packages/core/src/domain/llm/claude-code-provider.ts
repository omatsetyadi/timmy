import { Context, Effect, Stream } from 'effect'
import { homedir } from 'node:os'
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { LlmClient } from './llm-client'
import type { StreamChunk } from './stream-chunk'

/** The tools Claude Code may run WITHOUT a second prompt once Timmy's confirm gate has
 *  approved the delegation — the proven workflow-engine allowlist (spawn.ts). Scoped on
 *  purpose (vs `bypassPermissions`, which allows literally everything): Bash covers
 *  gh/docker/etc., but Claude Code can't reach beyond this set. */
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write']

/** Default Claude model askClaude runs on when `providers.claude_code.model` isn't set.
 *  Sonnet = balanced; override with opus (hard agentic work) or haiku (cheap/fast). */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6'

/** Curated set of Claude models askClaude can run — shown in `model status` so you know
 *  what to pick. There's no reliable list-models call for the subscription, so this is a
 *  hand-maintained menu; `model askclaude <id>` accepts ANY valid id, not just these. */
export const KNOWN_CLAUDE_MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5']

interface ClaudeBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
}
interface ClaudeMessage {
  type?: string
  message?: { content?: ClaudeBlock[] }
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** Map ONE Agent-SDK message → the first meaningful StreamChunk (or null). Pure; degrade-don't-die.
 *  Block shapes are Anthropic-standard and stable regardless of the SDK wrapper. */
export const claudeMessageToChunk = (m: ClaudeMessage): StreamChunk | null => {
  if (m.type === 'assistant' && m.message?.content) {
    for (const b of m.message.content) {
      if (b.type === 'thinking' && b.thinking) return { type: 'thinking', content: b.thinking }
      if (b.type === 'tool_use' && b.name)
        return {
          type: 'tool_call',
          toolCall: { id: b.id ?? '', name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }
      if (b.type === 'text' && b.text) return { type: 'content', content: b.text }
    }
  }
  if (m.type === 'result' && m.usage)
    return {
      type: 'usage',
      promptTokens: m.usage.input_tokens ?? 0,
      completionTokens: m.usage.output_tokens ?? 0,
    }
  return null
}

type Service = Context.Tag.Service<LlmClient>

/** A uniform provider over the Agent SDK. `tools` is accepted but unused for now (askClaude
 *  uses Claude Code's OWN tools). Later, claude-code-as-frontdesk will bridge `tools` into the
 *  SDK as MCP/SDK tools — ADDITIVE, no interface change.
 *
 *  Verified against @anthropic-ai/claude-agent-sdk 0.3.x: `query({ prompt, options })` returns a
 *  `Query` (AsyncGenerator<SDKMessage, void> + `interrupt(): Promise<void>`). Cancellation is via
 *  `options.abortController` (the proven workflow-engine `spawn.ts` mechanism); the finalizer
 *  aborts it and best-effort calls `interrupt()`. */
export interface ClaudeCodeOpts {
  /** Override the autonomous-tool allowlist (default: DEFAULT_ALLOWED_TOOLS). */
  allowedTools?: string[]
  /** "Auto mode": let Claude Code use ANY tool, no allowlist (SDK bypassPermissions). */
  bypassPermissions?: boolean
}

export const makeClaudeCodeProvider = (model: string, opts: ClaudeCodeOpts = {}): Service => ({
  // `tools` is intentionally omitted: askClaude uses Claude Code's OWN tools. A future
  // claude-code-as-frontdesk path will bridge `tools` into the SDK (additive, no interface change).
  chat: (messages) =>
    Stream.async<StreamChunk, never>((emit) => {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      const abortController = new AbortController()
      // Default: scoped allowlist (workflow-engine model) — Claude Code runs Bash/Edit/etc.
      // autonomously once Timmy's confirm gate approves, but nothing beyond the set. With
      // `bypassPermissions` ("auto mode") it can use ANY tool, no restriction.
      // cwd defaults to HOME so file/container work happens somewhere sensible — not in
      // Timmy's package dir where the server was launched.
      const options: Options = opts.bypassPermissions
        ? { model, permissionMode: 'bypassPermissions', cwd: homedir(), abortController }
        : {
            model,
            allowedTools: opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
            cwd: homedir(),
            abortController,
          }
      const session = query({ prompt: lastUser, options })
      const run = async (): Promise<void> => {
        try {
          for await (const msg of session) {
            const c = claudeMessageToChunk(msg as unknown as ClaudeMessage)
            if (c) emit.single(c)
          }
        } catch {
          emit.single({ type: 'error', message: 'Claude Code run failed' })
        }
        emit.single({ type: 'finish', reason: 'stop' })
        emit.end()
      }
      void run()
      return Effect.sync(() => {
        abortController.abort()
        void session.interrupt?.().catch(() => {})
      })
    }),
  isAvailable: () =>
    Effect.tryPromise(() =>
      import('node:child_process').then(
        ({ spawn }) =>
          new Promise<boolean>((resolve) => {
            const p = spawn('claude', ['auth', 'status'], { stdio: 'ignore' })
            p.on('error', () => resolve(false))
            p.on('close', (code) => resolve(code === 0))
          }),
      ),
    ).pipe(Effect.catchAll(() => Effect.succeed(false))),
  detectCapabilities: () =>
    Effect.succeed({ vision: true, audio: false, tools: true, realtime: false }),
})
