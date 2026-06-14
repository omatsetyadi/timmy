import { Schema } from 'effect'

/** Effect Schema mirroring the `timmy-sdk` `TimmyPlugin` contract. Used to validate
 *  dynamically-imported plugin modules before trusting them. `execute` is `Schema.Any`
 *  here (a function is not expressible as a data schema) and is checked structurally by
 *  the loader via `typeof t.execute === 'function'`. */
const ToolSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  riskLevel: Schema.Literal('safe', 'confirm', 'blocked'),
  execute: Schema.Any,
})

export const PluginSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.pattern(/^[^:]+$/)),
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
