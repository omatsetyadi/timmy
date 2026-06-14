import { Layer, ManagedRuntime } from 'effect'
import { join } from 'node:path'
import { CONFIG_DIR, Config, readConfigSync } from '../domain/config/config'
import { CredentialStore } from '../domain/credentials/credential-store'
import { Db } from '../domain/persistence/db'
import { ThreadStore } from '../domain/persistence/thread-store'
import { LlmClient } from '../domain/llm/llm-client'
import { ChatService } from '../domain/chat/chat-service'

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
 *   - `AppLayer` adds ChatService (needs Config + ThreadStore + LlmClient); `provideMerge(mid)`
 *     satisfies those AND keeps ThreadStore + the base services exposed.
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
  )

  const mid = ThreadStore.Live.pipe(Layer.provideMerge(base))

  const AppLayer = ChatService.Live.pipe(Layer.provideMerge(mid))

  return { runtime: ManagedRuntime.make(AppLayer), config: cfg }
}
