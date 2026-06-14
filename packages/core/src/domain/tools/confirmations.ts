import { Context, Deferred, Effect, Layer, Ref } from 'effect'

/** Open confirm-tier requests keyed by id; resolved by POST /confirm/:id. */
export class PendingConfirmations extends Context.Tag('timmy/tools/pending-confirmations')<
  PendingConfirmations,
  {
    readonly create: (id: string) => Effect.Effect<Deferred.Deferred<boolean>>
    readonly resolve: (id: string, allowed: boolean) => Effect.Effect<boolean>
    /** Drop a pending entry (e.g. on timeout/interrupt) so the map can't leak. */
    readonly remove: (id: string) => Effect.Effect<void>
  }
>() {
  static Live = Layer.effect(
    PendingConfirmations,
    Effect.gen(function* () {
      const ref = yield* Ref.make(new Map<string, Deferred.Deferred<boolean>>())
      return {
        create: (id) =>
          Effect.gen(function* () {
            const d = yield* Deferred.make<boolean>()
            yield* Ref.update(ref, (m) => new Map(m).set(id, d))
            return d
          }),
        resolve: (id, allowed) =>
          Effect.gen(function* () {
            const m = yield* Ref.get(ref)
            const d = m.get(id)
            if (!d) return false
            yield* Deferred.succeed(d, allowed)
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
