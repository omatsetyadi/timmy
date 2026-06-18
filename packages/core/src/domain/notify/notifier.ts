import { Context, Effect, Layer, Ref } from 'effect'

/**
 * A proactive push to the user — spoken aloud by the voice daemon (`notify` event on `/stream`) and
 * available to anything else that listens. `text` is spoken verbatim, so write it conversationally.
 * `thread_id` (optional) resumes a conversation so the user's reply lands back in that context.
 */
export interface Notification {
  readonly text: string
  readonly thread_id?: string
}

/**
 * Outbound proactive notifications. The TRANSPORT is registered once at server boot
 * (`setSink` → `io.emit('notify', …)`); PRODUCERS (e.g. a finished long-running task — Phase 7) just
 * resolve this service and call `notify`. The default sink is a no-op, so notifying before a
 * transport is attached (or in a headless context) is harmless rather than an error.
 */
export class Notifier extends Context.Tag('timmy/notify/Notifier')<
  Notifier,
  {
    readonly notify: (n: Notification) => Effect.Effect<void>
    readonly setSink: (sink: (n: Notification) => void) => Effect.Effect<void>
  }
>() {
  static Live = Layer.effect(
    Notifier,
    Effect.gen(function* () {
      const sink = yield* Ref.make<(n: Notification) => void>(() => {})
      return {
        notify: (n) => Ref.get(sink).pipe(Effect.flatMap((emit) => Effect.sync(() => emit(n)))),
        setSink: (s) => Ref.set(sink, s),
      }
    }),
  )
}
