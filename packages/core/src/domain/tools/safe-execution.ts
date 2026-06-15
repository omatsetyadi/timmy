import { Context, Deferred, Effect, Layer } from 'effect'
import type { Tool, ToolResult } from 'timmy-sdk'
import { Config, Permission } from '../config/config'
import { PendingConfirmations } from './confirmations'
import { resolvePermission } from './permission-resolver'
import { ToolSource } from './tool-source'

/** Emits a confirm_required signal (the tool-loop wires this to a stream chunk). */
export type EmitConfirm = (req: {
  id: string
  tool: string
  description: string
}) => Effect.Effect<void>

export class SafeExecution extends Context.Tag('timmy/tools/safe-execution')<
  SafeExecution,
  {
    /** Gate a tool call by its resolved permission; `run` executes only when allowed. */
    readonly run: (
      tool: Tool,
      args: Record<string, unknown>,
      id: string,
      emitConfirm: EmitConfirm,
      execute: () => Effect.Effect<ToolResult, never>,
    ) => Effect.Effect<ToolResult>
  }
>() {
  static Live = Layer.effect(
    SafeExecution,
    Effect.gen(function* () {
      const pending = yield* PendingConfirmations
      const cfg = yield* (yield* Config).get
      // Tool → owning plugin, for plugin-level permission overrides (core tools: undefined).
      const { credentialScopeByTool } = yield* ToolSource
      return {
        run: (tool, args, id, emitConfirm, execute) =>
          Effect.gen(function* () {
            const plugin = credentialScopeByTool.get(tool.name)?.plugin
            // Resolve allow/ask/block from config + the (dynamic) per-call risk. `args` matters
            // for runCommand (the command classifier); ignored for static-tier tools.
            const permission = resolvePermission({
              toolName: tool.name,
              riskLevel: tool.riskLevel,
              args,
              plugin,
              config: cfg.permissions,
            })
            if (permission === Permission.BLOCK) return { ok: false, error: 'blocked' }
            if (permission === Permission.ALLOW) return yield* execute()
            // ask: emit the prompt, then wait INDEFINITELY for the human's decision (Model A —
            // no timeout). `ensuring(remove)` drops the pending entry on a decision OR interrupt.
            const deferred = yield* pending.create(id)
            yield* emitConfirm({ id, tool: tool.name, description: `Run ${tool.name}?` })
            const allowed = yield* Deferred.await(deferred).pipe(
              Effect.ensuring(pending.remove(id)),
            )
            return allowed ? yield* execute() : { ok: false, error: 'declined' }
          }),
      }
    }),
  )
}
