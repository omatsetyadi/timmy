import { Context, Deferred, Effect, Layer } from 'effect'
import type { Tool, ToolResult } from 'timmy-sdk'
import { PendingConfirmations } from './confirmations'

/** Emits a confirm_required signal (the tool-loop wires this to a stream chunk). */
export type EmitConfirm = (req: {
  id: string
  tool: string
  description: string
}) => Effect.Effect<void>

export class SafeExecution extends Context.Tag('timmy/tools/safe-execution')<
  SafeExecution,
  {
    /** Gate a tool by risk tier; `run` executes the tool only when allowed. */
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
      return {
        run: (tool, _args, id, emitConfirm, execute) =>
          Effect.gen(function* () {
            if (tool.riskLevel === 'blocked') return { ok: false, error: 'blocked' }
            if (tool.riskLevel === 'safe') return yield* execute()
            // confirm tier: emit the prompt, then wait for the human's decision.
            const deferred = yield* pending.create(id)
            yield* emitConfirm({ id, tool: tool.name, description: `Run ${tool.name}?` })
            // Wait INDEFINITELY for allow/deny — Model A: a conversational/voice gate
            // waits as long as the user needs (no hard timeout). `ensuring(remove)` drops
            // the pending entry on a decision OR on interrupt — i.e. when the user abandons
            // the session (closes the connection) — so the map never leaks and an abandoned
            // action is simply never run. (Was a 30s timeout; removed in Phase 3c.)
            const allowed = yield* Deferred.await(deferred).pipe(
              Effect.ensuring(pending.remove(id)),
            )
            return allowed ? yield* execute() : { ok: false, error: 'declined' }
          }),
      }
    }),
  )
}
