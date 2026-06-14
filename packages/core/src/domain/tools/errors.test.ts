import { it } from '@effect/vitest'
import { Effect, Either } from 'effect'
import { expect } from 'vitest'
import { ToolError } from './errors'

it.effect('ToolError carries tag + tool name', () =>
  Effect.gen(function* () {
    const r = yield* Effect.either(Effect.fail(new ToolError({ message: 'boom', tool: 'openApp' })))
    expect(Either.isLeft(r)).toBe(true)
    if (Either.isLeft(r)) expect(r.left._tag).toBe('timmy/tools/ToolError')
  }),
)
