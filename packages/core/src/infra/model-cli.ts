import { Effect } from 'effect'
import { load, dump } from 'js-yaml'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Config, CONFIG_PATH, effectiveProviders } from '../domain/config/config'
import { CredentialStore } from '../domain/credentials/credential-store'
import { ProviderRegistry } from '../domain/llm/provider-registry'
import { DEFAULT_CLAUDE_MODEL, KNOWN_CLAUDE_MODELS } from '../domain/llm/claude-code-provider'

const apiKeyKey = (provider: string) => `model:${provider}:api_key`

interface RawConfig {
  models?: {
    frontdesk?: { provider: string; model: string }
    reasoning?: { default?: string }
  }
  providers?: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

const loadRaw = (): RawConfig => {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    const v = load(readFileSync(CONFIG_PATH, 'utf8'))
    return v && typeof v === 'object' ? (v as RawConfig) : {}
  } catch {
    return {}
  }
}
// NOTE: rewriting via js-yaml normalizes the file (drops comments) — accepted tradeoff.
const saveRaw = (cfg: RawConfig): void => writeFileSync(CONFIG_PATH, dump(cfg), 'utf8')

/** Set the frontdesk provider+model in config.yaml. base_url is resolved at boot (known
 *  providers) or read from the `providers` block, so it isn't written here. */
export const setFrontdeskConfig = (provider: string, model: string): void => {
  const raw = loadRaw()
  raw.models = { ...(raw.models ?? {}), frontdesk: { provider, model } }
  saveRaw(raw)
}

/** Set the model askClaude (Claude Code) runs on: `providers.claude_code.model`. Creates the
 *  claude_code provider entry if it's absent. */
export const setAskClaudeModel = (model: string): void => {
  const raw = loadRaw()
  const providers = raw.providers ?? {}
  providers.claude_code = { ...(providers.claude_code ?? {}), kind: 'claude-code', model }
  raw.providers = providers
  saveRaw(raw)
}

/** Toggle askClaude "auto mode": `providers.claude_code.bypass_permissions` (any tool, no
 *  allowlist). Creates the claude_code provider entry if it's absent. */
export const setAskClaudeBypass = (on: boolean): void => {
  const raw = loadRaw()
  const providers = raw.providers ?? {}
  providers.claude_code = {
    ...(providers.claude_code ?? {}),
    kind: 'claude-code',
    bypass_permissions: on,
  }
  raw.providers = providers
  saveRaw(raw)
}

/** Set (or clear, when target is null) `models.reasoning.default` in config.yaml. */
export const setReasoningConfig = (target: string | null): void => {
  const raw = loadRaw()
  const models = raw.models ?? {}
  if (target === null) {
    if (models.reasoning) delete models.reasoning.default
  } else {
    models.reasoning = { ...(models.reasoning ?? {}), default: target }
  }
  raw.models = models
  saveRaw(raw)
}

/** Discovered target ids ("provider/model") — used by the CLI to validate `model use/reasoning`. */
export const discoveredTargetIds = Effect.gen(function* () {
  const pool = yield* (yield* ProviderRegistry).pool
  return pool.map((t) => t.id)
})

export const setKey = (provider: string, key: string) =>
  Effect.gen(function* () {
    const creds = yield* CredentialStore
    yield* creds.set(apiKeyKey(provider), key)
  })

export interface StatusReport {
  frontdesk: { provider: string; model: string }
  reasoningDefault: string | null
  providers: { key: string; kind: string; hasKey: boolean; models: string[]; note?: string }[]
}

/** `claude auth status` exit 0 → logged in. Spawned directly (no SDK import on the status path). */
const claudeCodeAvailable = Effect.tryPromise(() =>
  import('node:child_process').then(
    ({ spawn }) =>
      new Promise<boolean>((resolve) => {
        const p = spawn('claude', ['auth', 'status'], { stdio: 'ignore' })
        p.on('error', () => resolve(false))
        p.on('close', (code) => resolve(code === 0))
      }),
  ),
).pipe(Effect.catchAll(() => Effect.succeed(false)))

export const statusReport = Effect.gen(function* () {
  const cfg = yield* (yield* Config).get
  const creds = yield* CredentialStore
  const pool = yield* (yield* ProviderRegistry).pool
  const declared = cfg.providers ?? {}
  const providers = Object.entries(effectiveProviders(cfg)) // includes implicit Ollama default
  const rows: StatusReport['providers'] = []
  for (const [key, pc] of providers) {
    if (pc.kind === 'claude-code') {
      // Not an askModel reasoning target (it's askClaude's agentic engine), so no discovered
      // models — but report truthful availability via `claude auth status` + a clarifying note.
      const available = yield* claudeCodeAvailable
      const model = pc.model ?? DEFAULT_CLAUDE_MODEL
      const auto = pc.bypass_permissions === true ? ', auto-mode ON' : ''
      rows.push({
        key,
        kind: pc.kind,
        hasKey: available,
        models: KNOWN_CLAUDE_MODELS, // pickable via `model askclaude <model>` (not askModel targets)
        note: `askClaude's agentic engine — currently ${model}${auto}; pick one above with \`model askclaude <model>\`. Not an askModel reasoning target.`,
      })
      continue
    }
    const models = pool.filter((t) => t.providerKey === key).map((t) => t.model)
    // Hide the implicit Ollama default when it isn't running (no models) and wasn't declared,
    // so cloud-only setups don't see an empty Ollama row. A declared provider always shows.
    if (!(key in declared) && models.length === 0) continue
    const hasKey = pc.kind === 'openai-compat' ? (yield* creds.get(apiKeyKey(key))) !== null : true
    rows.push({ key, kind: pc.kind, hasKey, models })
  }
  return {
    frontdesk: { provider: cfg.models.frontdesk.provider, model: cfg.models.frontdesk.model },
    reasoningDefault: cfg.models.reasoning?.default ?? null,
    providers: rows,
  } satisfies StatusReport
})

// ── timmy init (first-run setup — unrelated to PM2/daemon lifecycle) ─────────────

export interface InitChoices {
  frontdesk: { provider: string; model: string }
  claudeAuthed: boolean
  /** a cloud provider set up during init (e.g. 'deepseek'); added to the providers block. */
  cloudProvider?: string
}

/** Detect the local environment for `timmy init`: reachable Ollama models + Claude Code auth.
 *  Needs no services (fetch + `claude auth status`), so it runs before any config exists. */
export const detectEnv = Effect.gen(function* () {
  const ollamaModels = yield* Effect.tryPromise(() =>
    fetch('http://localhost:11434/api/tags').then(
      (r) => r.json() as Promise<{ models?: { name: string }[] }>,
    ),
  ).pipe(
    Effect.map((d) => (d.models ?? []).map((m) => m.name)),
    Effect.catchAll(() => Effect.succeed([] as string[])),
  )
  const claudeAuthed = yield* claudeCodeAvailable
  return { ollamaModels, claudeAuthed }
})

/** Pure: the config object `timmy init` writes. Ollama is implicit (effectiveProviders) so it
 *  isn't written; claude_code is added when logged in; a chosen cloud provider is added with its
 *  base_url auto-resolved (known providers) — its API key is stored separately in the keychain. */
export const buildInitConfig = (c: InitChoices): RawConfig => {
  const providers: Record<string, Record<string, unknown>> = {}
  if (c.claudeAuthed) providers.claude_code = { kind: 'claude-code' }
  if (c.cloudProvider) providers[c.cloudProvider] = { kind: 'openai-compat' }
  const raw: RawConfig = { models: { frontdesk: c.frontdesk } }
  if (Object.keys(providers).length > 0) raw.providers = providers
  return raw
}

/** Write the init config to `~/.timmy/config.yaml`. */
export const writeInitConfig = (c: InitChoices): void => saveRaw(buildInitConfig(c))
