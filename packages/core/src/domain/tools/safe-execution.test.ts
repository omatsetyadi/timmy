import { it } from '@effect/vitest'
import { Effect, Fiber, Layer, TestClock } from 'effect'
import { expect } from 'vitest'
import type { Tool } from 'timmy-sdk'
import { PendingConfirmations } from './confirmations'
import { SafeExecution } from './safe-execution'

const mk = (riskLevel: Tool['riskLevel']): Tool => ({
  name: 't',
  description: 'd',
  riskLevel,
  parameters: {},
  execute: async () => ({ ok: true, data: 'ran' }),
})
const layer = SafeExecution.Live.pipe(Layer.provideMerge(PendingConfirmations.Live))
const noEmit = () => Effect.void

it.effect('safe tier runs immediately', () =>
  Effect.gen(function* () {
    const se = yield* SafeExecution
    const r = yield* se.run(mk('safe'), {}, 'id1', noEmit, () =>
      Effect.succeed({ ok: true, data: 'ran' }),
    )
    expect(r.data).toBe('ran')
  }).pipe(Effect.provide(layer)),
)

it.effect('blocked tier never runs', () =>
  Effect.gen(function* () {
    const se = yield* SafeExecution
    const r = yield* se.run(mk('blocked'), {}, 'id2', noEmit, () => Effect.die('should not run'))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('blocked')
  }).pipe(Effect.provide(layer)),
)

// Approve/decline use the real clock (it.live): they rely on a forked fiber blocking on
// the Deferred while the main fiber sleeps then resolves it. Under it.effect's TestClock,
// Effect.sleep never advances on its own, so these would deadlock. The 30s-timeout case
// below stays on it.effect + TestClock.adjust (the plan's intended timeout test).
it.live('confirm tier resolves when approved', () =>
  Effect.gen(function* () {
    const pc = yield* PendingConfirmations
    const se = yield* SafeExecution
    const fiber = yield* Effect.fork(
      se.run(mk('confirm'), {}, 'id3', noEmit, () => Effect.succeed({ ok: true, data: 'ran' })),
    )
    yield* Effect.sleep('10 millis')
    yield* pc.resolve('id3', true)
    const exit = yield* Fiber.await(fiber)
    expect(exit._tag).toBe('Success')
    if (exit._tag === 'Success') expect(exit.value.data).toBe('ran')
  }).pipe(Effect.provide(layer)),
)

it.live('confirm tier declines when rejected', () =>
  Effect.gen(function* () {
    const pc = yield* PendingConfirmations
    const se = yield* SafeExecution
    const fiber = yield* Effect.fork(
      se.run(mk('confirm'), {}, 'id4', noEmit, () => Effect.die('should not run')),
    )
    yield* Effect.sleep('10 millis')
    yield* pc.resolve('id4', false)
    const r = yield* Fiber.join(fiber)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('declined')
  }).pipe(Effect.provide(layer)),
)

it.effect('confirm tier times out (distinct from declined) after 30s', () =>
  Effect.gen(function* () {
    const se = yield* SafeExecution
    const fiber = yield* Effect.fork(
      se.run(mk('confirm'), {}, 'id5', noEmit, () => Effect.die('should not run')),
    )
    yield* TestClock.adjust('31 seconds')
    const r = yield* Fiber.join(fiber)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('timeout')
  }).pipe(Effect.provide(layer)),
)
