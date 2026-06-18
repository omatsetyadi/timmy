import { Layer, ManagedRuntime, Effect } from 'effect'
import { join } from 'node:path'
import {
  CONFIG_DIR,
  Config,
  effectiveProviders,
  readConfigSync,
  type TimmyConfig,
} from '../domain/config/config'
import { CredentialStore } from '../domain/credentials/credential-store'
import { Notifier } from '../domain/notify/notifier'
import { Db } from '../domain/persistence/db'
import { ThreadStore } from '../domain/persistence/thread-store'
import { LlmClient } from '../domain/llm/llm-client'
import { makeProvider, type ProviderTarget } from '../domain/llm/provider'
import { ProviderRegistry } from '../domain/llm/provider-registry'
import { KNOWN_BASE_URLS, resolveBaseUrl } from '../domain/llm/known-providers'
import { ChatService } from '../domain/chat/chat-service'
import { PluginToolSource } from '../domain/tools/plugin-tool-source'
import { CoreToolSource } from '../domain/tools/core-tool-source'
import { mergeToolSources } from '../domain/tools/tool-source'
import { ToolRegistry } from '../domain/tools/tool-registry'
import { SafeExecution } from '../domain/tools/safe-execution'
import { PendingConfirmations } from '../domain/tools/confirmations'
import { PermissionOverlay } from '../domain/tools/permission-overlay'
import { EntityStore } from '../domain/memory/entity-store'
import { Embedder } from '../domain/memory/embedder'
import { Recall } from '../domain/memory/recall'
import { Extractor } from '../domain/memory/extract'

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

/** Resolve the frontdesk target from config. Kind precedence: the configured provider's kind
 *  (incl. the implicit Ollama default) → a **known cloud provider** (openai/deepseek/anthropic/
 *  gemini) is `openai-compat` → otherwise `ollama`. The known-cloud step is what stops an
 *  all-cloud frontdesk (whose provider may not be an explicit `providers:` entry) from silently
 *  falling back to Ollama and erroring with "ollama request failed". */
export const frontdeskTarget = (cfg: TimmyConfig): ProviderTarget => {
  const f = cfg.models.frontdesk
  const pc = effectiveProviders(cfg)[f.provider]
  const kind = pc?.kind ?? (f.provider in KNOWN_BASE_URLS ? 'openai-compat' : 'ollama')
  return {
    providerKey: f.provider,
    kind,
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
    PermissionOverlay.Live,
    Notifier.Live,
  )

  // ProviderRegistry needs Config + CredentialStore; FrontdeskLlm too.
  const llmLayer = Layer.mergeAll(FrontdeskLlm, ProviderRegistry.Live).pipe(
    Layer.provideMerge(base),
  )

  // Memory tier. EntityStore needs Db; Embedder needs Config (both in llmLayer's output via
  // its provideMerge(base)). Recall needs Config + EntityStore + Embedder; Extractor needs
  // LlmClient + EntityStore + Embedder. mergeAll does NOT cross-wire siblings, so build the
  // leaves first (EntityStore + Embedder), then layer Recall + Extractor on top with
  // provideMerge so the leaves stay in the output channel AND satisfy the dependents.
  //   memBase  : EntityStore + Embedder, requirements met by llmLayer.
  //   memLayer : Recall + Extractor provided memBase (for EntityStore/Embedder) which itself
  //              still needs Config/LlmClient — satisfied by provideMerge(llmLayer). The result
  //              exposes EntityStore, Embedder, Recall, Extractor (+ everything llmLayer carries).
  const memBase = Layer.mergeAll(EntityStore.Live, Embedder.Live)
  const memLayer = Layer.mergeAll(Recall.Live, Extractor.Live).pipe(
    Layer.provideMerge(memBase),
    Layer.provideMerge(llmLayer),
  )

  // Tool sources: core (needs Config + creds + ProviderRegistry + EntityStore + Recall) merged
  // with plugins. CoreToolSource gets memLayer (which carries llmLayer's services too) so all of
  // its requirements are satisfied.
  const toolSource = mergeToolSources(
    CoreToolSource.pipe(Layer.provide(memLayer)),
    PluginToolSource,
  )

  // Both the registry (to hide blocked tools) and SafeExecution (to resolve a tool's owning
  // plugin for permission overrides) now read the ToolSource, so provide it to the whole tier.
  // provideMerge(memLayer) (which itself carries llmLayer's services) keeps Recall + Extractor —
  // alongside LlmClient/ThreadStore/Config/… — in the output channel so ChatService (added in
  // AppLayer via provideMerge(mid)) can yield them.
  const mid = Layer.mergeAll(ThreadStore.Live, SafeExecution.Live, ToolRegistry.Live).pipe(
    Layer.provide(toolSource),
    Layer.provideMerge(memLayer),
  )

  const AppLayer = ChatService.Live.pipe(Layer.provideMerge(mid))

  return { runtime: ManagedRuntime.make(AppLayer), config: cfg }
}
