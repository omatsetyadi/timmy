import { Context, Effect, Layer } from 'effect'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'

export interface FrontdeskConfig {
  provider: string
  base_url?: string
  model: string
}
/** The assistant — its own identity. `name` = what it's called; `personality` = its character/voice.
 *  `voice_style` = an extra register fragment appended ONLY on voice-channel turns (spoken replies). */
export interface AssistantConfig {
  name: string
  personality: string
  voice_style: string
  language: { proactive: string; conversation: string; supported: string[] }
}

/** The user — who the assistant is talking to. User-authored, injected into every system prompt;
 *  the agent never writes here (distinct from the auto-learned memory graph).
 *  `name` = the user's name; `about` = who they are (grounding); `style` = how to respond to them. */
export interface UserConfig {
  name?: string
  about?: string
  style?: string
}
export type ProviderKind = 'ollama' | 'openai-compat' | 'claude-code'
export interface ProviderConfig {
  kind: ProviderKind
  base_url?: string
  /** claude-code only: which Claude model askClaude runs on (e.g. claude-opus-4-8 for hard
   *  agentic work, claude-haiku-4-5 for cheap/fast). Defaults to DEFAULT_CLAUDE_MODEL. */
  model?: string
  /** claude-code only: "auto mode" — let Claude Code use ANY tool with NO restriction
   *  (SDK `permissionMode: 'bypassPermissions'`) instead of the scoped allowlist. Off by
   *  default; the scoped allowlist (Read/Glob/Grep/Bash/Edit/Write) is the safe default. */
  bypass_permissions?: boolean
}
export interface ReasoningConfig {
  default?: string // "<provider>/<model>"
}

/** The permission decision for a tool call — the universal allow/ask/block triad. */
export const Permission = { ALLOW: 'allow', ASK: 'ask', BLOCK: 'block' } as const
export type Permission = (typeof Permission)[keyof typeof Permission]

/** Global friction posture: `default` respects each tool's decision (mostly open, ask on
 *  risky); `yolo` auto-allows everything except `block` (like Claude's auto mode). */
export const PermissionMode = { DEFAULT: 'default', YOLO: 'yolo' } as const
export type PermissionMode = (typeof PermissionMode)[keyof typeof PermissionMode]

export interface PermissionConfig {
  mode: PermissionMode
  /** Per-plugin overrides, keyed by plugin name. */
  plugins?: Record<string, Permission>
  /** Per-tool overrides, keyed by the namespaced tool name (`<plugin>__<tool>`) or a bare core name. */
  tools?: Record<string, Permission>
  /** runCommand's personal allowlist — shell commands the user has chosen to always allow. */
  commands?: { allow?: string[] }
}

/** Voice settings — read by the separate `timmy-voice` Python daemon (over the same config file).
 *  Keys are a contract with the daemon; do NOT rename. Language stays under `assistant.language`. */
export interface VoiceConfig {
  stt: { engine?: string; model?: string }
  tts: {
    engine: 'local' | 'openai'
    voice?: string
    rate?: number
    openai?: { model?: string; voice?: string; instructions?: string }
  }
  wake: { word: string; phrase?: string }
}

export interface TimmyConfig {
  server: { host: string; port: number; auth: { enabled: boolean; token: 'keychain' | string } }
  models: {
    frontdesk: FrontdeskConfig
    reasoning?: ReasoningConfig
    vision?: ReasoningConfig
    embedding?: string
    memory?: string
  }
  providers?: Record<string, ProviderConfig>
  permissions: PermissionConfig
  assistant: AssistantConfig
  user?: UserConfig
  voice: VoiceConfig
  memory: {
    learning_mode: boolean
    notify_on_learn: boolean
    always_kinds: string[]
    recall_limit: number
    recall_budget: number
    /** Explicit memorySearch default limit — broader than the silent recall budget. */
    search_limit: number
    /** Hard cap on memoryList output (truncates explicitly past this). */
    list_cap: number
  }
}

export const CONFIG_DIR = join(homedir(), '.timmy')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml')

// Behavior only — no name. buildSystemPrompt leads with "You are <assistant.name>, a personal
// AI assistant." so the name is config-driven (and CLI-editable), not baked into this string.
const DEFAULT_PERSONALITY =
  `Talk like a close friend — casual, direct, no corporate tone. ` +
  `Skip filler like "Certainly!" or "Great question!". Be concise. If you don't know, say so. Light roast when it fits. ` +
  `Only claim an action succeeded if a tool result confirms it. If there's no tool or native way to do something, ` +
  `say so plainly after a reasonable attempt — don't brute-force the shell over and over.`

// Appended to the system prompt ONLY on voice-channel turns (spoken replies). Prompt-shaped guidance,
// NOT a code-level length cap — the model self-regulates and gives a full answer the moment it's asked.
const DEFAULT_VOICE_STYLE =
  `You're speaking out loud, not writing. Keep replies short and conversational — usually one or two ` +
  `sentences. No markdown, lists, or headings. Lead with the answer. When there's more worth saying, ` +
  `give the short version and offer it — "want the details?" — and expand only if asked. A full, long ` +
  `answer is welcome the moment they ask for it. Talk like a person, not a document.`

const DEFAULTS: TimmyConfig = {
  server: { host: '127.0.0.1', port: 3737, auth: { enabled: true, token: 'keychain' } },
  models: {
    frontdesk: { provider: 'ollama', base_url: 'http://localhost:11434', model: 'qwen3:14b' },
  },
  permissions: { mode: 'default' },
  assistant: {
    name: 'Timmy',
    personality: DEFAULT_PERSONALITY,
    voice_style: DEFAULT_VOICE_STYLE,
    language: { proactive: 'en', conversation: 'auto', supported: ['en', 'id'] },
  },
  voice: {
    stt: {},
    tts: { engine: 'local' },
    wake: { word: 'hey_jarvis' },
  },
  memory: {
    learning_mode: true,
    notify_on_learn: true,
    // Empty: recall is query-driven (semantic top-K + neighbors). The always-on "core memory" role
    // is now the user PROFILE (assistant/user about+style); force-injecting a whole entity kind every
    // turn floods recall (e.g. all `preference` entities) regardless of the message. Set a kind here
    // only for a genuinely tiny, always-relevant set.
    always_kinds: [],
    recall_limit: 5,
    recall_budget: 15,
    search_limit: 25,
    list_cap: 200,
  },
}

function loadConfig(path: string): TimmyConfig {
  if (!existsSync(path)) return DEFAULTS
  const raw = load(readFileSync(path, 'utf8'))
  if (raw === null || typeof raw !== 'object') return DEFAULTS
  const f = raw as Partial<TimmyConfig>
  return {
    server: {
      ...DEFAULTS.server,
      ...f.server,
      auth: { ...DEFAULTS.server.auth, ...f.server?.auth },
    },
    models: {
      frontdesk: { ...DEFAULTS.models.frontdesk, ...f.models?.frontdesk },
      ...(f.models?.reasoning ? { reasoning: f.models.reasoning } : {}),
      ...(f.models?.vision ? { vision: f.models.vision } : {}),
      ...(f.models?.embedding ? { embedding: f.models.embedding } : {}),
      ...(f.models?.memory ? { memory: f.models.memory } : {}),
    },
    ...(f.providers ? { providers: f.providers } : {}),
    permissions: { ...DEFAULTS.permissions, ...f.permissions },
    assistant: {
      ...DEFAULTS.assistant,
      ...f.assistant,
      language: { ...DEFAULTS.assistant.language, ...f.assistant?.language },
    },
    ...(f.user ? { user: f.user } : {}),
    voice: {
      ...DEFAULTS.voice,
      ...f.voice,
      stt: { ...DEFAULTS.voice.stt, ...f.voice?.stt },
      tts: {
        ...DEFAULTS.voice.tts,
        ...f.voice?.tts,
        // Only materialize `openai` when the file actually sets it — keeps the default block clean.
        ...(f.voice?.tts?.openai
          ? { openai: { ...DEFAULTS.voice.tts.openai, ...f.voice.tts.openai } }
          : {}),
      },
      wake: { ...DEFAULTS.voice.wake, ...f.voice?.wake },
    },
    memory: { ...DEFAULTS.memory, ...f.memory },
  }
}

/** Synchronously load the config (defaults merged with the file at `path`, if any).
 *  Exposes the internal `loadConfig` so callers (e.g. the runtime) can read concrete
 *  values eagerly to parameterize layers like `Db.Live(dbPath)` / `LlmClient.Live(cfg)`. */
export function readConfigSync(path: string = CONFIG_PATH): TimmyConfig {
  return loadConfig(path)
}

/** Providers as Timmy effectively sees them. **Ollama is an implicit local default** — it's
 *  Timmy's local-first LLM, so it's always part of the provider set (auto-discovered at
 *  localhost:11434) even without a `providers.ollama` entry. A declared `ollama` (e.g. a custom
 *  base_url) overrides the implicit default. */
export function effectiveProviders(cfg: TimmyConfig): Record<string, ProviderConfig> {
  return { ollama: { kind: 'ollama' }, ...(cfg.providers ?? {}) }
}

export class Config extends Context.Tag('timmy/config/config')<
  Config,
  { readonly get: Effect.Effect<TimmyConfig> }
>() {
  static Live = (path: string = CONFIG_PATH) =>
    Layer.effect(
      Config,
      Effect.sync(() => {
        const cfg = loadConfig(path) // loaded once at layer construction
        return { get: Effect.succeed(cfg) }
      }),
    )
}
