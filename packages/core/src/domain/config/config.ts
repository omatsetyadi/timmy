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
export interface AssistantConfig {
  name: string
  personality: string
  language: { proactive: string; conversation: string; supported: string[] }
}
export interface TimmyConfig {
  server: { host: string; port: number; auth: { enabled: boolean; token: 'keychain' | string } }
  models: { frontdesk: FrontdeskConfig }
  assistant: AssistantConfig
}

export const CONFIG_DIR = join(homedir(), '.timmy')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml')

const DEFAULT_PERSONALITY =
  `You are Timmy, a personal AI assistant. Talk like a close friend — casual, direct, no corporate tone. ` +
  `Skip filler like "Certainly!" or "Great question!". Be concise. If you don't know, say so. Light roast when it fits.`

const DEFAULTS: TimmyConfig = {
  server: { host: '127.0.0.1', port: 3737, auth: { enabled: true, token: 'keychain' } },
  models: {
    frontdesk: { provider: 'ollama', base_url: 'http://localhost:11434', model: 'qwen3:14b' },
  },
  assistant: {
    name: 'Timmy',
    personality: DEFAULT_PERSONALITY,
    language: { proactive: 'en', conversation: 'auto', supported: ['en', 'id'] },
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
    models: { frontdesk: { ...DEFAULTS.models.frontdesk, ...f.models?.frontdesk } },
    assistant: {
      ...DEFAULTS.assistant,
      ...f.assistant,
      language: { ...DEFAULTS.assistant.language, ...f.assistant?.language },
    },
  }
}

/** Synchronously load the config (defaults merged with the file at `path`, if any).
 *  Exposes the internal `loadConfig` so callers (e.g. the runtime) can read concrete
 *  values eagerly to parameterize layers like `Db.Live(dbPath)` / `LlmClient.Live(cfg)`. */
export function readConfigSync(path: string = CONFIG_PATH): TimmyConfig {
  return loadConfig(path)
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
