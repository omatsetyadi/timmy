import { Layer, ManagedRuntime } from 'effect'
import { join } from 'node:path'
import { CONFIG_DIR, Config, readConfigSync } from '../domain/config/config'
import { CredentialStore } from '../domain/credentials/credential-store'
import { Db } from '../domain/persistence/db'
import { ThreadStore } from '../domain/persistence/thread-store'
import { LlmClient } from '../domain/llm/llm-client'
import { ChatService } from '../domain/chat/chat-service'
import { PluginToolSource } from '../domain/tools/plugin-tool-source'
import { ToolRegistry } from '../domain/tools/tool-registry'
import { SafeExecution } from '../domain/tools/safe-execution'
import { PendingConfirmations } from '../domain/tools/confirmations'

/**
 * Build the full application layer once at boot and wrap it in a ManagedRuntime.
 *
 * Config is read eagerly (synchronously) so we can parameterize the leaf layers
 * (`Db.Live(dbPath)`, `LlmClient.Live({ baseUrl, model })`) with concrete values.
 *
 * Layer wiring — the goal is `Layer<…, never, never>` (no unmet requirements):
 *   - `base` merges the dependency-free layers: Config, Db, CredentialStore, LlmClient.
 *   - `mid` adds ThreadStore (needs Db); `provideMerge(base)` satisfies Db AND keeps
 *     every base service in the output channel.
 *   - `mid` also adds the tools services: SafeExecution (needs PendingConfirmations) and
 *     ToolRegistry (needs ToolSource). Phase 3b wires `PluginToolSource`, which loads plugins
 *     from `~/.timmy/plugins/` at boot (empty when none installed → `/chat` behaves like the
 *     foundation). `PluginToolSource` has no requirements, so it stays a dependency-free leaf
 *     of `base`, exactly like the `ToolSource.empty` it replaces.
 *   - `AppLayer` adds ChatService (needs Config + ThreadStore + LlmClient + ToolRegistry +
 *     SafeExecution); `provideMerge(mid)` satisfies those AND keeps the rest exposed.
 *
 * Using `provideMerge` (not `provide`) everywhere is what keeps ChatService, ThreadStore,
 * LlmClient, Db, Config and CredentialStore all in the success channel so the runtime can
 * resolve each of them via `runtime.runPromise(Tag…)`.
 */
export function buildRuntime() {
  const cfg = readConfigSync()
  const dbPath = join(CONFIG_DIR, 'timmy.db')
  const frontdesk = cfg.models.frontdesk

  const base = Layer.mergeAll(
    Config.Live(),
    Db.Live(dbPath),
    CredentialStore.Live,
    LlmClient.Live({
      baseUrl: frontdesk.base_url ?? 'http://localhost:11434',
      model: frontdesk.model,
    }),
    PendingConfirmations.Live,
    PluginToolSource,
  )

  const mid = Layer.mergeAll(ThreadStore.Live, SafeExecution.Live, ToolRegistry.Live).pipe(
    Layer.provideMerge(base),
  )

  const AppLayer = ChatService.Live.pipe(Layer.provideMerge(mid))

  return { runtime: ManagedRuntime.make(AppLayer), config: cfg }
}
