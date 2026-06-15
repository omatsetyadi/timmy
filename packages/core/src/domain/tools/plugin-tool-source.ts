import { Effect, Layer } from 'effect'
import { join } from 'node:path'
import type { Tool, TimmyPlugin } from 'timmy-sdk'
import { CONFIG_DIR } from '../config/config'
import { PluginLoader } from './plugin-loader'
import { ToolSource, type CredentialScope } from './tool-source'

/** Provider-safe namespaced tool name: OpenAI/DeepSeek require function names to match
 *  this exact shape. The composite `<plugin>__<tool>` is validated against it; a tool that
 *  would exceed 64 chars (or otherwise fail) is dropped rather than risking a chat-time 400. */
const NAMESPACED_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/** Pure: turn loaded plugins into the {@link ToolSource} payload. Each plugin tool is
 *  re-keyed to `<plugin>__<tool>` so the model-facing name is collision-free across plugins
 *  and the credential scope is recorded under that same namespaced name. Extracted from the
 *  Layer so the namespacing rules are unit-testable without touching the filesystem. */
export function buildPluginToolSource(plugins: readonly TimmyPlugin[]): {
  tools: Tool[]
  credentialScopeByTool: Map<string, CredentialScope>
} {
  const tools: Tool[] = []
  const credentialScopeByTool = new Map<string, CredentialScope>()
  for (const p of plugins) {
    const keys = (p.credentials ?? []).map((c) => c.key)
    for (const t of p.tools) {
      const name = `${p.name}__${t.name}`
      if (!NAMESPACED_NAME.test(name)) continue // over-length / illegal composite → drop
      if (credentialScopeByTool.has(name)) continue // first-wins (mirrors registry de-dup)
      tools.push({ ...t, name })
      credentialScopeByTool.set(name, { plugin: p.name, keys: [...keys] })
    }
  }
  return { tools, credentialScopeByTool }
}

/** A {@link ToolSource} backed by the {@link PluginLoader}: scans `<CONFIG_DIR>/plugins`,
 *  loads every plugin, and namespaces its tools via {@link buildPluginToolSource} so each
 *  tool's model-facing name is `<plugin>__<tool>` and its credential scope (owning plugin +
 *  that plugin's declared keys) is recorded for least-privilege resolution in the registry. */
export const PluginToolSource = Layer.effect(
  ToolSource,
  Effect.gen(function* () {
    const plugins = yield* PluginLoader.load(join(CONFIG_DIR, 'plugins'))
    return buildPluginToolSource(plugins)
  }),
)
