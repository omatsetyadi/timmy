import { Effect, Layer } from 'effect'
import { join } from 'node:path'
import { CONFIG_DIR } from '../config/config'
import { PluginLoader } from './plugin-loader'
import { ToolSource, type CredentialScope } from './tool-source'

/** A {@link ToolSource} backed by the {@link PluginLoader}: scans `<CONFIG_DIR>/plugins`,
 *  flattens every loaded plugin's tools, and records each tool's credential scope (its
 *  owning plugin + that plugin's declared credential keys) so {@link ToolRegistry} can
 *  hand each tool a least-privilege `credentials.get`.
 *
 *  Duplicate tool names across plugins: the loader returns plugins in directory order;
 *  the registry already de-dupes by name (first wins, later ones logged + ignored). To stay
 *  consistent, this map records the first plugin that claims a given tool name. */
export const PluginToolSource = Layer.effect(
  ToolSource,
  Effect.gen(function* () {
    const plugins = yield* PluginLoader.load(join(CONFIG_DIR, 'plugins'))
    const tools = plugins.flatMap((p) => p.tools)
    const credentialScopeByTool = new Map<string, CredentialScope>()
    for (const p of plugins) {
      const keys = (p.credentials ?? []).map((c) => c.key)
      for (const t of p.tools) {
        // First plugin to claim a tool name owns its credential scope, mirroring the
        // registry's first-wins de-dup so a tool's scope matches the tool that runs.
        if (!credentialScopeByTool.has(t.name)) {
          credentialScopeByTool.set(t.name, { plugin: p.name, keys: [...keys] })
        }
      }
    }
    return { tools, credentialScopeByTool }
  }),
)
