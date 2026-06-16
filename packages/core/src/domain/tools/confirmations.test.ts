import { describe, it, expect } from 'vitest'
import { Effect, ManagedRuntime } from 'effect'
import { PendingConfirmations } from './confirmations'

const run = <A>(f: (p: typeof PendingConfirmations.Service) => Effect.Effect<A>): Promise<A> => {
  const rt = ManagedRuntime.make(PendingConfirmations.Live)
  return rt.runPromise(PendingConfirmations.pipe(Effect.flatMap(f))).finally(() => rt.dispose())
}

describe('PendingConfirmations.peek', () => {
  it('returns the stored always payload, then null after resolve', async () => {
    const out = await run((p) =>
      Effect.gen(function* () {
        yield* p.create('id1', { scope: 'tool', tool: 'runAppleScript' })
        const before = yield* p.peek('id1')
        yield* p.resolve('id1', true)
        const after = yield* p.peek('id1')
        return { before, after }
      }),
    )
    expect(out.before).toEqual({ scope: 'tool', tool: 'runAppleScript' })
    expect(out.after).toBeNull()
  })
})
