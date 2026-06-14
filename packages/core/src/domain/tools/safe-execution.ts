import { Context, Deferred, Effect, Layer, Option } from 'effect'
import type { Tool, ToolResult } from 'timmy-sdk'
import { PendingConfirmations } from './confirmations'

const CONFIRM_TIMEOUT = '30 seconds'

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
            // confirm:
            const deferred = yield* pending.create(id)
            yield* emitConfirm({ id, tool: tool.name, description: `Run ${tool.name}?` })
            // Await the human's decision; `ensuring(remove)` drops the pending entry
            // on success, timeout, OR interrupt so the map can't leak. timeoutOption
            // → None = no answer in time (timeout), Some(allowed) = explicit decision.
            const decision = yield* Deferred.await(deferred).pipe(
              Effect.timeoutOption(CONFIRM_TIMEOUT),
              Effect.ensuring(pending.remove(id)),
            )
            if (Option.isNone(decision)) return { ok: false, error: 'timeout' }
            return decision.value ? yield* execute() : { ok: false, error: 'declined' }
          }),
      }
    }),
  )
}
