import { Context, Layer } from 'effect'
import type { Tool } from 'timmy-sdk'

/** Supplies the registered tools. Phase 3a: empty or stub. Phase 3b: PluginLoader-backed. */
export class ToolSource extends Context.Tag('timmy/tools/source')<
  ToolSource,
  { readonly tools: readonly Tool[] }
>() {
  // NOTE: named `layer` rather than the plan's `of` — `Context.Tag` already declares a
  // static `of(self: Value): Value`, so a static `of` returning a `Layer` collides (TS2417).
  static layer = (tools: readonly Tool[]): Layer.Layer<ToolSource> =>
    Layer.succeed(ToolSource, { tools })
  static empty: Layer.Layer<ToolSource> = Layer.succeed(ToolSource, { tools: [] })
}
