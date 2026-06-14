import { Context, Layer } from 'effect'
import type { Tool } from 'timmy-sdk'

/** The credential scope for a single tool: the plugin that owns it and the credential
 *  keys that plugin declared. The registry uses this to build a least-privilege
 *  `credentials.get` that only resolves the owning plugin's declared keys. */
export interface CredentialScope {
  readonly plugin: string
  readonly keys: readonly string[]
}

/** Supplies the registered tools plus, per tool, its credential scope.
 *
 *  Phase 3a callers register bare tool lists via {@link ToolSource.layer}/{@link ToolSource.empty};
 *  those carry an empty `credentialScopeByTool`, so such tools see NO credentials (no owning
 *  plugin, nothing declared). Phase 3b's `PluginToolSource` populates the map from each plugin's
 *  `credentials[].key`, so a plugin's tools see exactly that plugin's declared keys. */
export class ToolSource extends Context.Tag('timmy/tools/source')<
  ToolSource,
  {
    readonly tools: readonly Tool[]
    /** tool name → its owning plugin + the credential keys that plugin declared. */
    readonly credentialScopeByTool: ReadonlyMap<string, CredentialScope>
  }
>() {
  // NOTE: named `layer` rather than the plan's `of` — `Context.Tag` already declares a
  // static `of(self: Value): Value`, so a static `of` returning a `Layer` collides (TS2417).
  static layer = (tools: readonly Tool[]): Layer.Layer<ToolSource> =>
    Layer.succeed(ToolSource, { tools, credentialScopeByTool: new Map() })
  static empty: Layer.Layer<ToolSource> = Layer.succeed(ToolSource, {
    tools: [],
    credentialScopeByTool: new Map(),
  })
}
