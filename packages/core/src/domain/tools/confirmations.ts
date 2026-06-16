import { Context, Deferred, Effect, Layer, Ref } from 'effect'
// TYPE-only import: avoids a runtime cycle with safe-execution.ts (which imports this Tag).
import type { AlwaysPayload } from './safe-execution'

/** Open confirm-tier requests keyed by id; resolved by POST /confirm/:id. */
export class PendingConfirmations extends Context.Tag('timmy/tools/pending-confirmations')<
  PendingConfirmations,
  {
    readonly create: (
      id: string,
      always: AlwaysPayload,
    ) => Effect.Effect<Deferred.Deferred<boolean>>
    /** What an "always allow" on this pending entry would persist; null if no such entry. */
    readonly peek: (id: string) => Effect.Effect<AlwaysPayload | null>
    readonly resolve: (id: string, allowed: boolean) => Effect.Effect<boolean>
    /** Drop a pending entry (e.g. on timeout/interrupt) so the map can't leak. */
    readonly remove: (id: string) => Effect.Effect<void>
  }
>() {
  static Live = Layer.effect(
    PendingConfirmations,
    Effect.gen(function* () {
      const ref = yield* Ref.make(
        new Map<string, { d: Deferred.Deferred<boolean>; always: AlwaysPayload }>(),
      )
      return {
        create: (id, always) =>
          Effect.gen(function* () {
            const d = yield* Deferred.make<boolean>()
            yield* Ref.update(ref, (m) => new Map(m).set(id, { d, always }))
            return d
          }),
        peek: (id) => Ref.get(ref).pipe(Effect.map((m) => m.get(id)?.always ?? null)),
        resolve: (id, allowed) =>
          Effect.gen(function* () {
            const m = yield* Ref.get(ref)
            const e = m.get(id)
            if (!e) return false
            yield* Deferred.succeed(e.d, allowed)
            yield* Ref.update(ref, (mm) => {
              const n = new Map(mm)
              n.delete(id)
              return n
            })
            return true
          }),
        remove: (id) =>
          Ref.update(ref, (m) => {
            if (!m.has(id)) return m
            const n = new Map(m)
            n.delete(id)
            return n
          }),
      }
    }),
  )
}
