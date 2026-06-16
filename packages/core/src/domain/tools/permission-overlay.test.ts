import { describe, it, expect } from 'vitest'
import { Effect, ManagedRuntime } from 'effect'
import { emptyOverlay, mergeOverlay, PermissionOverlay } from './permission-overlay'
import type { PermissionConfig } from '../config/config'

const base: PermissionConfig = {
  mode: 'default',
  tools: { askClaude: 'allow' },
  commands: { allow: ['ls'] },
}

describe('mergeOverlay', () => {
  it('returns the base unchanged for an empty overlay', () => {
    expect(mergeOverlay(base, emptyOverlay())).toEqual({
      mode: 'default',
      tools: { askClaude: 'allow' },
      commands: { allow: ['ls'] },
    })
  })

  it('overlay mode wins; tool overrides merge per key; commands union + dedupe', () => {
    expect(
      mergeOverlay(base, {
        mode: 'yolo',
        tools: { runAppleScript: 'allow' },
        commands: ['ls', 'git commit'],
      }),
    ).toEqual({
      mode: 'yolo',
      tools: { askClaude: 'allow', runAppleScript: 'allow' },
      commands: { allow: ['ls', 'git commit'] },
    })
  })

  it('handles a base with no tools/commands set', () => {
    expect(mergeOverlay({ mode: 'default' }, { tools: { x: 'ask' }, commands: ['a'] })).toEqual({
      mode: 'default',
      tools: { x: 'ask' },
      commands: { allow: ['a'] },
    })
  })
})

const run = <A>(f: (o: typeof PermissionOverlay.Service) => Effect.Effect<A>): Promise<A> => {
  const rt = ManagedRuntime.make(PermissionOverlay.Live)
  return rt.runPromise(PermissionOverlay.pipe(Effect.flatMap(f))).finally(() => rt.dispose())
}

describe('PermissionOverlay service', () => {
  it('starts empty', async () => {
    expect(await run((o) => o.get)).toEqual({ tools: {}, commands: [] })
  })

  it('setMode, allowTool, allowCommand (dedupe) accumulate', async () => {
    const state = await run((o) =>
      Effect.gen(function* () {
        yield* o.setMode('yolo')
        yield* o.allowTool('runAppleScript')
        yield* o.allowCommand('git commit')
        yield* o.allowCommand('git commit') // dedupe
        return yield* o.get
      }),
    )
    expect(state).toEqual({
      mode: 'yolo',
      tools: { runAppleScript: 'allow' },
      commands: ['git commit'],
    })
  })

  it('setOverride records a non-allow permission', async () => {
    const state = await run((o) =>
      Effect.gen(function* () {
        yield* o.setOverride('webSearch', 'ask')
        return yield* o.get
      }),
    )
    expect(state.tools).toEqual({ webSearch: 'ask' })
  })
})
