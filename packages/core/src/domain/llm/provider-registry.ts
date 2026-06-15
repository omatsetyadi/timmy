import { Context, Effect, Layer, Ref } from 'effect'
import { Config, type ProviderConfig } from '../config/config'
import { CredentialStore } from '../credentials/credential-store'
import { resolveBaseUrl } from './known-providers'

export interface DiscoveredTarget {
  id: string // "<provider>/<model>"
  providerKey: string
  model: string
}

const apiKeyKey = (provider: string) => `model:${provider}:api_key`

/** Best-effort model discovery for one provider. Returns [] on any failure (logged by caller). */
export const discoverModels = (
  providerKey: string,
  cfg: ProviderConfig,
  apiKey: string | null,
): Effect.Effect<string[]> => {
  if (cfg.kind === 'ollama') {
    return Effect.tryPromise(() =>
      fetch(`${cfg.base_url ?? 'http://localhost:11434'}/api/tags`).then(
        (r) => r.json() as Promise<{ models?: { name: string }[] }>,
      ),
    ).pipe(
      Effect.map((d) => (d.models ?? []).map((m) => m.name)),
      Effect.catchAll(() => Effect.succeed([])),
    )
  }
  if (cfg.kind === 'openai-compat') {
    const baseUrl = resolveBaseUrl(providerKey, cfg.base_url)
    return Effect.tryPromise(() =>
      fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey ?? ''}` } }).then(
        (r) => r.json() as Promise<{ data?: { id: string }[] }>,
      ),
    ).pipe(
      Effect.map((d) => (d.data ?? []).map((m) => m.id)),
      Effect.catchAll(() => Effect.succeed([])),
    )
  }
  // claude-code discovery is added in its own task; default empty here.
  return Effect.succeed([])
}

export class ProviderRegistry extends Context.Tag('timmy/llm/provider-registry')<
  ProviderRegistry,
  {
    readonly pool: Effect.Effect<readonly DiscoveredTarget[]>
    readonly refresh: Effect.Effect<readonly DiscoveredTarget[]>
  }
>() {
  static Live = Layer.effect(
    ProviderRegistry,
    Effect.gen(function* () {
      const cfg = yield* (yield* Config).get
      const creds = yield* CredentialStore
      const providers = cfg.providers ?? {}

      const discoverAll = Effect.gen(function* () {
        const out: DiscoveredTarget[] = []
        for (const [providerKey, pc] of Object.entries(providers)) {
          const key = pc.kind === 'openai-compat' ? yield* creds.get(apiKeyKey(providerKey)) : null
          const models = yield* discoverModels(providerKey, pc, key)
          // claude-code intentionally has no discovered reasoning models (it's askClaude's
          // agentic engine, not an askModel target) — don't log it as "unavailable".
          if (models.length === 0 && pc.kind !== 'claude-code')
            yield* Effect.logInfo(
              `provider '${providerKey}' discovered no models (unavailable or no key)`,
            )
          for (const model of models)
            out.push({ id: `${providerKey}/${model}`, providerKey, model })
        }
        return out
      })

      const ref = yield* Ref.make<readonly DiscoveredTarget[]>(yield* discoverAll)
      return {
        pool: Ref.get(ref),
        refresh: Effect.gen(function* () {
          const next = yield* discoverAll
          yield* Ref.set(ref, next)
          return next
        }),
      }
    }),
  )
}
