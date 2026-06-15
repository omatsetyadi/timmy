import { Layer, ManagedRuntime, Effect } from 'effect'
import { join } from 'node:path'
import { CONFIG_DIR, Config, readConfigSync, type TimmyConfig } from '../domain/config/config'
import { CredentialStore } from '../domain/credentials/credential-store'
import { Db } from '../domain/persistence/db'
import { ThreadStore } from '../domain/persistence/thread-store'
import { LlmClient } from '../domain/llm/llm-client'
import { makeProvider, type ProviderTarget } from '../domain/llm/provider'
import { ProviderRegistry } from '../domain/llm/provider-registry'
import { resolveBaseUrl } from '../domain/llm/known-providers'
import { ChatService } from '../domain/chat/chat-service'
import { PluginToolSource } from '../domain/tools/plugin-tool-source'
import { CoreToolSource } from '../domain/tools/core-tool-source'
import { mergeToolSources } from '../domain/tools/tool-source'
import { ToolRegistry } from '../domain/tools/tool-registry'
import { SafeExecution } from '../domain/tools/safe-execution'
import { PendingConfirmations } from '../domain/tools/confirmations'

/**
 * Build the full application layer once at boot and wrap it in a ManagedRuntime.
 *
 * Config is read eagerly (synchronously) so we can parameterize the leaf layers
 * (`Db.Live(dbPath)`) with concrete values.
 *
 * Layer wiring — the goal is `Layer<…, never, never>` (no unmet requirements):
 *   - `base` merges the dependency-free / config-driven leaves: Config, Db, CredentialStore,
 *     PendingConfirmations.
 *   - `llmLayer` adds the frontdesk `LlmClient` (selected by provider kind via `makeProvider`,
 *     resolving any cloud key from `CredentialStore`) and `ProviderRegistry` (auto-discovers the
 *     reasoning pool). Both need Config + CredentialStore; `provideMerge(base)` satisfies those AND
 *     keeps every base service in the output channel.
 *   - `toolSource` is the merge of `CoreToolSource` (the first-party `askModel` tool — needs
 *     Config + CredentialStore + ProviderRegistry) and `PluginToolSource` (loads `~/.timmy/plugins/`
 *     at boot; empty when none installed). CoreToolSource is provided `llmLayer` so its requirements
 *     are met; the merged result is a dependency-free `Layer<ToolSource>`.
 *   - `mid` adds ThreadStore (needs Db), SafeExecution (needs PendingConfirmations) and ToolRegistry
 *     (needs ToolSource + CredentialStore). `ToolRegistry.Live` is provided `toolSource` for its
 *     ToolSource requirement; `provideMerge(llmLayer)` then satisfies the rest (CredentialStore, Db…)
 *     AND keeps every upstream service exposed.
 *   - `AppLayer` adds ChatService (needs Config + ThreadStore + LlmClient + ToolRegistry +
 *     SafeExecution); `provideMerge(mid)` satisfies those AND keeps the rest exposed.
 *
 * Using `provideMerge` (not `provide`) for the cumulative layers is what keeps ChatService,
 * ThreadStore, LlmClient, ProviderRegistry, Db, Config and CredentialStore all in the success
 * channel so the runtime can resolve each of them via `runtime.runPromise(Tag…)`.
 */

/** Resolve the frontdesk target from config (kind comes from the providers map; falls back
 *  to ollama for the default single-provider config). */
const frontdeskTarget = (cfg: TimmyConfig): ProviderTarget => {
  const f = cfg.models.frontdesk
  const pc = cfg.providers?.[f.provider]
  return {
    providerKey: f.provider,
    kind: pc?.kind ?? 'ollama',
    model: f.model,
    baseUrl: resolveBaseUrl(f.provider, pc?.base_url ?? f.base_url),
  }
}

const FrontdeskLlm = Layer.effect(
  LlmClient,
  Effect.gen(function* () {
    const cfg = yield* (yield* Config).get
    const creds = yield* CredentialStore
    const target = frontdeskTarget(cfg)
    const apiKey =
      target.kind === 'openai-compat'
        ? yield* creds.get(`model:${target.providerKey}:api_key`)
        : null
    return makeProvider({ ...target, apiKey: apiKey ?? undefined })
  }),
)

export function buildRuntime() {
  const cfg = readConfigSync()
  const dbPath = join(CONFIG_DIR, 'timmy.db')

  // Dependency-free leaves + Config/Db/creds.
  const base = Layer.mergeAll(
    Config.Live(),
    Db.Live(dbPath),
    CredentialStore.Live,
    PendingConfirmations.Live,
  )

  // ProviderRegistry needs Config + CredentialStore; FrontdeskLlm too.
  const llmLayer = Layer.mergeAll(FrontdeskLlm, ProviderRegistry.Live).pipe(
    Layer.provideMerge(base),
  )

  // Tool sources: core (needs Config + creds + ProviderRegistry) merged with plugins.
  const toolSource = mergeToolSources(
    CoreToolSource.pipe(Layer.provide(llmLayer)),
    PluginToolSource,
  )

  const mid = Layer.mergeAll(
    ThreadStore.Live,
    SafeExecution.Live,
    ToolRegistry.Live.pipe(Layer.provide(toolSource)),
  ).pipe(Layer.provideMerge(llmLayer))

  const AppLayer = ChatService.Live.pipe(Layer.provideMerge(mid))

  return { runtime: ManagedRuntime.make(AppLayer), config: cfg }
}
