import { Effect, Layer, Stream } from 'effect'
import { Config, effectiveProviders, type ProviderConfig } from '../config/config'
import { CredentialStore } from '../credentials/credential-store'
import { ProviderRegistry } from '../llm/provider-registry'
import { makeProvider, type ProviderTarget } from '../llm/provider'
import { resolveBaseUrl } from '../llm/known-providers'
import { DEFAULT_CLAUDE_MODEL } from '../llm/claude-code-provider'
import { buildAskModelTool } from '../reasoning/model-router'
import { buildAskClaudeTool } from '../reasoning/ask-claude'
import type { StreamChunk } from '../llm/stream-chunk'
import { buildRunCommandTool } from './run-command-tool'
import { buildWebSearchTool, buildFetchUrlTool, TAVILY_KEY } from './web-search-tool'
import { ToolSource } from './tool-source'

const apiKeyKey = (provider: string) => `model:${provider}:api_key`

/** First-party core tools (currently: askModel). Inside the trust boundary — reads
 *  `model:*` keys directly via CredentialStore (the per-plugin sandbox is for untrusted
 *  third-party plugins). Provided with an EMPTY credentialScopeByTool: core tools don't
 *  use the per-tool ctx.credentials path. */
export const CoreToolSource = Layer.effect(
  ToolSource,
  Effect.gen(function* () {
    const cfg = yield* (yield* Config).get
    const creds = yield* CredentialStore
    const registry = yield* ProviderRegistry
    const providers: Record<string, ProviderConfig> = effectiveProviders(cfg) // implicit Ollama default
    const pool = yield* registry.pool

    const resolveTarget = (id: string): ProviderTarget | null => {
      const i = id.indexOf('/')
      if (i <= 0) return null
      const providerKey = id.slice(0, i)
      const model = id.slice(i + 1)
      const pc = providers[providerKey]
      if (!pc) return null
      return {
        providerKey,
        kind: pc.kind,
        model,
        baseUrl: resolveBaseUrl(providerKey, pc.base_url),
      }
    }

    const askModel = buildAskModelTool({
      resolveTarget,
      getKey: (provider) => Effect.runPromise(creds.get(apiKeyKey(provider))),
      runChat: (target, prompt) =>
        makeProvider(target).chat([{ role: 'user', content: prompt }]) as Stream.Stream<
          never,
          unknown
        >,
      defaultTargetId: () => cfg.models.reasoning?.default ?? null,
      poolIds: () => pool.map((p) => p.id),
    })

    const ccProvider = providers['claude_code']
    const ccModel = ccProvider?.model ?? DEFAULT_CLAUDE_MODEL
    const cc = ccProvider
      ? makeProvider({
          providerKey: 'claude_code',
          kind: 'claude-code',
          model: ccModel,
          bypassPermissions: ccProvider.bypass_permissions === true, // "auto mode" toggle
        })
      : null
    const askClaudeTool = cc
      ? [
          buildAskClaudeTool({
            available: () => Effect.runPromise(cc.isAvailable()),
            run: (task) =>
              cc.chat([{ role: 'user', content: task }]) as Stream.Stream<StreamChunk, never>,
          }),
        ]
      : []
    // The direct terminal tool — the cheap, always-available path (no Claude needed). Its
    // per-command permission is decided by the classifier + resolver, not the static tier.
    const runCommand = buildRunCommandTool()
    // Web search + page fetch (Tavily). Key read directly from the store (core tools are inside
    // the trust boundary); no key → the tool tells the user to run `timmy search set-key`.
    const tavilyKey = () => Effect.runPromise(creds.get(TAVILY_KEY))
    const webSearch = buildWebSearchTool(tavilyKey)
    const fetchUrl = buildFetchUrlTool(tavilyKey)
    return {
      tools: [askModel, runCommand, webSearch, fetchUrl, ...askClaudeTool],
      credentialScopeByTool: new Map(),
    }
  }),
)
