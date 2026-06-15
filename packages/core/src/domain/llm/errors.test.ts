import { it } from '@effect/vitest'
import { Effect, Either } from 'effect'
import { expect, it as itV } from 'vitest'
import { AuthError, RateLimitError } from './errors'

it.effect('RateLimitError carries tag + fields', () =>
  Effect.gen(function* () {
    const r = yield* Effect.either(
      Effect.fail(new RateLimitError({ message: 'slow down', resetsAt: 123 })),
    )
    expect(Either.isLeft(r)).toBe(true)
    if (Either.isLeft(r)) {
      expect(r.left._tag).toBe('timmy/llm/RateLimitError')
      expect(r.left.resetsAt).toBe(123)
    }
  }),
)

itV('AuthError carries a message and provider, is a tagged error', () => {
  const e = new AuthError({ message: 'no api key', provider: 'deepseek' })
  expect(e._tag).toBe('timmy/llm/AuthError')
  expect(e.provider).toBe('deepseek')
})
