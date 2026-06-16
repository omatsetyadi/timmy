import { it } from '@effect/vitest'
import { describe } from 'vitest'
import { Effect, Fiber, Layer, Option, TestClock } from 'effect'
import { expect } from 'vitest'
import type { Tool } from 'timmy-sdk'
import { Config } from '../config/config'
import { PendingConfirmations } from './confirmations'
import { PermissionOverlay } from './permission-overlay'
import { SafeExecution, confirmDescription, computeAlways, alwaysLabel } from './safe-execution'
import { ToolSource } from './tool-source'

describe('computeAlways / alwaysLabel', () => {
  const cmdTool = {
    name: 'runCommand',
    allowSignature: (a: Record<string, unknown>) =>
      String(a.command ?? '')
        .split(/\s+/)
        .slice(0, 2)
        .join(' ') || null,
  } as unknown as Tool
  const plainTool = { name: 'runAppleScript' } as unknown as Tool

  it('command scope when allowSignature returns a signature', () => {
    const p = computeAlways(cmdTool, { command: 'git commit -m x' })
    expect(p).toEqual({ scope: 'command', signature: 'git commit' })
    expect(alwaysLabel(p)).toBe('git commit')
  })
  it('tool scope when allowSignature is absent or null', () => {
    const p = computeAlways(plainTool, { script: 'tell app' })
    expect(p).toEqual({ scope: 'tool', tool: 'runAppleScript' })
    expect(alwaysLabel(p)).toBe('runAppleScript')
  })
})

describe('confirmDescription', () => {
  it('shows the actual args (so the user sees the real command/script)', () => {
    expect(confirmDescription({ script: 'tell application "Photo Booth" to activate' })).toContain(
      'tell application "Photo Booth"',
    )
    expect(confirmDescription({ command: 'rm -rf /tmp/x' })).toContain('rm -rf /tmp/x')
  })
  it('handles no-arg tools', () => {
    expect(confirmDescription({})).toBe('(no arguments)')
  })
  it('truncates a huge arg', () => {
    const r = confirmDescription({ script: 'x'.repeat(5000) })
    expect(r.length).toBeLessThan(1000)
    expect(r).toContain('…')
  })
})

const mk = (riskLevel: Tool['riskLevel']): Tool => ({
  name: 't',
  description: 'd',
  riskLevel,
  parameters: {},
  execute: async () => ({ ok: true, data: 'ran' }),
})
// Default config (no file) → permissions { mode: 'default' }, so safe→allow, confirm→ask,
// blocked→block — identical to the pre-resolver behavior these tests assert.
const layer = SafeExecution.Live.pipe(
  Layer.provideMerge(PendingConfirmations.Live),
  // PermissionOverlay is a SafeExecution dependency, read at resolve time. provideMerge keeps the
  // service in the output channel so tests can obtain it and set overlay entries before running.
  // An empty overlay is a no-op via mergeOverlay, so the existing tests are unaffected.
  Layer.provideMerge(PermissionOverlay.Live),
  Layer.provide(Config.Live('/nonexistent/timmy-test.yaml')),
  Layer.provide(ToolSource.empty),
)
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

// Phase 3c: Model A — the confirm gate has NO timeout. It waits as long as the user
// needs; a late decision still runs. (Old behavior: auto-'timeout' after 30s. With the
// old code this test fails — advancing the clock would resolve the gate as 'timeout'
// before we ever call resolve, so the tool would never run.)
it.effect('confirm tier does NOT time out — waits indefinitely, a late decision still runs', () =>
  Effect.gen(function* () {
    const pc = yield* PendingConfirmations
    const se = yield* SafeExecution
    const fiber = yield* Effect.fork(
      se.run(mk('confirm'), {}, 'id5', noEmit, () => Effect.succeed({ ok: true, data: 'ran' })),
    )
    // Advance far past the old 30s timeout — the gate must STILL be pending, not resolved.
    yield* TestClock.adjust('10 minutes')
    expect(yield* Fiber.poll(fiber)).toStrictEqual(Option.none())
    // A late 'allow' still works (no abandonment): the tool runs.
    yield* pc.resolve('id5', true)
    const r = yield* Fiber.join(fiber)
    expect(r).toStrictEqual({ ok: true, data: 'ran' })
  }).pipe(Effect.provide(layer)),
)

// The live overlay is read at resolve time: once allowTool() names a confirm-tier tool, it
// resolves to ALLOW and runs WITHOUT emitting a confirm — no restart, no Deferred wait.
it.effect('overlay allowTool makes a confirm-tier tool run without asking', () =>
  Effect.gen(function* () {
    const overlay = yield* PermissionOverlay
    const se = yield* SafeExecution
    let confirmed = false
    const emitConfirm: typeof noEmit = () => {
      confirmed = true
      return Effect.void
    }
    // mk('confirm').name is 't' — allow that exact tool in the live overlay.
    yield* overlay.allowTool('t')
    const r = yield* se.run(mk('confirm'), {}, 'id6', emitConfirm, () =>
      Effect.succeed({ ok: true, data: 'ran' }),
    )
    expect(confirmed).toBe(false)
    expect(r).toStrictEqual({ ok: true, data: 'ran' })
  }).pipe(Effect.provide(layer)),
)
