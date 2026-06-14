import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'

export interface FrontdeskConfig {
  /** ollama | openai | anthropic | gemini | deepseek | custom (Phase 2 ships ollama) */
  provider: string
  base_url?: string
  model: string
}

export interface AssistantConfig {
  name: string
  personality: string
  language: {
    /** language for Timmy-initiated messages (notifications) */
    proactive: string
    /** 'auto' = mirror the user's language */
    conversation: string
    supported: string[]
  }
}

/** Shape of ~/.timmy/config.yaml (Phase 1–2 subset — grows in later phases). */
export interface TimmyConfig {
  server: {
    host: string
    port: number
    auth: {
      enabled: boolean
      /** 'keychain' means the token is read from the OS keychain, not the file. */
      token: 'keychain' | string
    }
  }
  models: {
    frontdesk: FrontdeskConfig
  }
  assistant: AssistantConfig
}

export const CONFIG_DIR = join(homedir(), '.timmy')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml')

const DEFAULT_PERSONALITY = `You are Timmy, a personal AI assistant. Talk like a close friend — casual, direct, no corporate tone. Skip filler like "Certainly!" or "Great question!". Be concise. If you don't know, say so. Light roast when it fits.`

const DEFAULT_CONFIG: TimmyConfig = {
  server: {
    host: '127.0.0.1',
    port: 3737,
    auth: { enabled: true, token: 'keychain' },
  },
  models: {
    frontdesk: {
      provider: 'ollama',
      base_url: 'http://localhost:11434',
      model: 'qwen3:14b',
    },
  },
  assistant: {
    name: 'Timmy',
    personality: DEFAULT_PERSONALITY,
    language: { proactive: 'en', conversation: 'auto', supported: ['en', 'id'] },
  },
}

/**
 * Load ~/.timmy/config.yaml merged over the defaults. Missing file → defaults.
 * Each known block is shallow-merged so a partial config still gets defaults.
 */
export function loadConfig(path: string = CONFIG_PATH): TimmyConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG

  const raw = load(readFileSync(path, 'utf8'))
  if (raw === null || typeof raw !== 'object') return DEFAULT_CONFIG
  const file = raw as Partial<TimmyConfig>

  return {
    server: {
      ...DEFAULT_CONFIG.server,
      ...file.server,
      auth: { ...DEFAULT_CONFIG.server.auth, ...file.server?.auth },
    },
    models: {
      frontdesk: { ...DEFAULT_CONFIG.models.frontdesk, ...file.models?.frontdesk },
    },
    assistant: {
      ...DEFAULT_CONFIG.assistant,
      ...file.assistant,
      language: { ...DEFAULT_CONFIG.assistant.language, ...file.assistant?.language },
    },
  }
}
