import { Context, Effect, Layer } from 'effect'
import type { Tool, ToolResult } from 'timmy-sdk'
import { ToolError, ToolNotFoundError } from './errors'
import { ToolSource } from './tool-source'

export interface ModelTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export class ToolRegistry extends Context.Tag('timmy/tools/registry')<
  ToolRegistry,
  {
    readonly list: () => readonly Tool[]
    readonly toModelTools: () => ModelTool[]
    readonly execute: (
      name: string,
      args: Record<string, unknown>,
    ) => Effect.Effect<ToolResult, ToolError | ToolNotFoundError>
  }
>() {
  static Live = Layer.effect(
    ToolRegistry,
    Effect.gen(function* () {
      const { tools } = yield* ToolSource
      const byName = new Map<string, Tool>()
      for (const t of tools) {
        if (byName.has(t.name)) {
          yield* Effect.logWarning(`duplicate tool '${t.name}' ignored`)
          continue
        }
        byName.set(t.name, t)
      }
      const credentials = { get: async () => null } // 3a stub; 3b injects per-plugin creds
      return {
        list: () => [...byName.values()],
        toModelTools: () =>
          [...byName.values()].map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        execute: (name, args) =>
          Effect.gen(function* () {
            const tool = byName.get(name)
            if (!tool)
              return yield* Effect.fail(
                new ToolNotFoundError({ message: `unknown tool: ${name}`, tool: name }),
              )
            // tryPromise provides an AbortSignal that fires on interruption, so an
            // interrupted turn cancels in-flight tool work. (SafeExecution gating is
            // applied by the caller before this runs.)
            return yield* Effect.tryPromise({
              try: (abortSignal) => tool.execute(args, { credentials, signal: abortSignal }),
              catch: (e) =>
                new ToolError({ message: `tool '${name}' failed`, tool: name, cause: e }),
            })
          }),
      }
    }),
  )
}
