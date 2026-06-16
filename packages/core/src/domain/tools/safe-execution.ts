import { Context, Deferred, Effect, Layer } from 'effect'
import type { Tool, ToolResult } from 'timmy-sdk'
import { Config, Permission } from '../config/config'
import { PendingConfirmations } from './confirmations'
import { PermissionOverlay, mergeOverlay } from './permission-overlay'
import { resolvePermission } from './permission-resolver'
import { ToolSource } from './tool-source'

/** Emits a confirm_required signal (the tool-loop wires this to a stream chunk). */
export type EmitConfirm = (req: {
  id: string
  tool: string
  description: string
  always: { scope: 'command' | 'tool'; label: string }
}) => Effect.Effect<void>

/** A preview of what a tool call will actually do — shown in the confirm prompt so the user
 *  approves with sight of the real command/script, not just the tool name. Truncates long args. */
export const confirmDescription = (args: Record<string, unknown>): string => {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (entries.length === 0) return '(no arguments)'
  const trunc = (s: string): string => (s.length > 600 ? s.slice(0, 600) + '…' : s)
  return entries.map(([k, v]) => `${k}: ${trunc(String(v))}`).join('\n')
}

/** The persistence target for an "always allow" decision on a tool call. */
export type AlwaysPayload =
  | { scope: 'command'; signature: string }
  | { scope: 'tool'; tool: string }

/** Command scope when the tool yields a signature (runCommand); else tool scope. */
export function computeAlways(tool: Tool, args: Record<string, unknown>): AlwaysPayload {
  const sig = tool.allowSignature?.(args) ?? null
  return sig ? { scope: 'command', signature: sig } : { scope: 'tool', tool: tool.name }
}

export const alwaysLabel = (p: AlwaysPayload): string =>
  p.scope === 'command' ? p.signature : p.tool

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
      const overlay = yield* PermissionOverlay
      return {
        run: (tool, args, id, emitConfirm, execute) =>
          Effect.gen(function* () {
            const plugin = credentialScopeByTool.get(tool.name)?.plugin
            // Read the live overlay HERE (not at layer init) and merge it over the boot config so
            // in-session permission changes (always-allow, /permissions, Shift+Tab) apply now.
            const ov = yield* overlay.get
            // Resolve allow/ask/block from config + the (dynamic) per-call risk. `args` matters
            // for runCommand (the command classifier); ignored for static-tier tools.
            const permission = resolvePermission({
              toolName: tool.name,
              riskLevel: tool.riskLevel,
              args,
              plugin,
              config: mergeOverlay(cfg.permissions, ov),
              classify: tool.classify,
            })
            if (permission === Permission.BLOCK) return { ok: false, error: 'blocked' }
            if (permission === Permission.ALLOW) return yield* execute()
            // ask: emit the prompt, then wait INDEFINITELY for the human's decision (Model A —
            // no timeout). `ensuring(remove)` drops the pending entry on a decision OR interrupt.
            const always = computeAlways(tool, args)
            const deferred = yield* pending.create(id, always)
            yield* emitConfirm({
              id,
              tool: tool.name,
              description: confirmDescription(args),
              always: { scope: always.scope, label: alwaysLabel(always) },
            })
            const allowed = yield* Deferred.await(deferred).pipe(
              Effect.ensuring(pending.remove(id)),
            )
            return allowed ? yield* execute() : { ok: false, error: 'declined' }
          }),
      }
    }),
  )
}
