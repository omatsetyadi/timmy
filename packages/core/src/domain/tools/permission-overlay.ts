import { Context, Effect, Layer, Ref } from 'effect'
import { Permission, type PermissionConfig, type PermissionMode } from '../config/config'

/** Session permission deltas applied since boot, on top of config.yaml. The daemon owns this;
 *  in-chat actions (always-allow, Shift+Tab, /permissions) mutate it for live effect, and also
 *  write through to config.yaml for persistence. */
export interface OverlayState {
  mode?: PermissionMode
  tools: Record<string, Permission>
  commands: string[]
}

export const emptyOverlay = (): OverlayState => ({ tools: {}, commands: [] })

/** Merge the live overlay over the boot config snapshot. Overlay mode (when set) wins; overlay
 *  tool overrides win per key; overlay commands union into the allowlist (deduped). Pure. */
export function mergeOverlay(base: PermissionConfig, overlay: OverlayState): PermissionConfig {
  return {
    ...base,
    mode: overlay.mode ?? base.mode,
    tools: { ...base.tools, ...overlay.tools },
    commands: {
      allow: Array.from(new Set([...(base.commands?.allow ?? []), ...overlay.commands])),
    },
  }
}

/** Daemon-side live permission overlay. Read at tool-resolve time (NOT layer init) so changes
 *  take effect without a restart. */
export class PermissionOverlay extends Context.Tag('timmy/tools/permission-overlay')<
  PermissionOverlay,
  {
    readonly get: Effect.Effect<OverlayState>
    readonly setMode: (mode: PermissionMode) => Effect.Effect<void>
    readonly allowTool: (name: string) => Effect.Effect<void>
    readonly allowCommand: (signature: string) => Effect.Effect<void>
    readonly setOverride: (name: string, perm: Permission) => Effect.Effect<void>
  }
>() {
  static Live = Layer.effect(
    PermissionOverlay,
    Effect.gen(function* () {
      const ref = yield* Ref.make<OverlayState>(emptyOverlay())
      return {
        get: Ref.get(ref),
        setMode: (mode) => Ref.update(ref, (s) => ({ ...s, mode })),
        allowTool: (name) =>
          Ref.update(ref, (s) => ({ ...s, tools: { ...s.tools, [name]: Permission.ALLOW } })),
        allowCommand: (sig) =>
          Ref.update(ref, (s) =>
            s.commands.includes(sig) ? s : { ...s, commands: [...s.commands, sig] },
          ),
        setOverride: (name, perm) =>
          Ref.update(ref, (s) => ({ ...s, tools: { ...s.tools, [name]: perm } })),
      }
    }),
  )
}
