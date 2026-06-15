import { Schema } from 'effect'

/** Effect Schema mirroring the `timmy-sdk` `TimmyPlugin` contract. Used to validate
 *  dynamically-imported plugin modules before trusting them. `execute` is `Schema.Any`
 *  here (a function is not expressible as a data schema) and is checked structurally by
 *  the loader via `typeof t.execute === 'function'`. */

/** Tool names are sent verbatim to every frontdesk provider as function names. OpenAI
 *  and DeepSeek reject anything outside `^[a-zA-Z0-9_-]{1,64}$`, and the registry namespaces
 *  plugin tools as `<plugin>__<tool>`, so a tool name must be provider-safe AND must not
 *  itself contain `__` (which would make the namespace split ambiguous). */
const ToolName = Schema.String.pipe(
  Schema.pattern(/^[a-zA-Z0-9_-]+$/),
  Schema.filter((n) => !n.includes('__'), { message: () => 'tool name must not contain "__"' }),
)

const ToolSchema = Schema.Struct({
  name: ToolName,
  description: Schema.String,
  parameters: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  riskLevel: Schema.Literal('safe', 'confirm', 'blocked'),
  execute: Schema.Any,
})

export const PluginSchema = Schema.Struct({
  // Optional here (not required) so the loader can emit a clear "incompatible plugin API"
  // message for a missing/old/new version instead of a generic decode failure.
  apiVersion: Schema.optional(Schema.Number),
  // Kebab-case only. The name prefixes the keychain credential namespace (`<name>:<key>`)
  // AND the model-facing tool name (`<name>__<tool>`), so it must be colon-free and
  // provider-safe; lowercase-kebab keeps both unambiguous. (Documented in the SDK README.)
  name: Schema.String.pipe(Schema.pattern(/^[a-z0-9-]+$/)),
  version: Schema.String,
  credentials: Schema.optional(
    Schema.Array(
      Schema.Struct({
        key: Schema.String,
        label: Schema.String,
        type: Schema.Literal('secret', 'oauth', 'text'),
      }),
    ),
  ),
  tools: Schema.Array(ToolSchema),
})

export const decodePlugin = Schema.decodeUnknownEither(PluginSchema)
