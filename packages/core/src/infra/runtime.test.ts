import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'
import { buildRuntime } from './runtime'
import { ToolRegistry } from '../domain/tools/tool-registry'

it('boots and registers the askModel core tool (no plugins installed)', async () => {
  const { runtime } = buildRuntime()
  const names = await runtime.runPromise(
    Effect.gen(function* () {
      const reg = yield* ToolRegistry
      return reg.list().map((t) => t.name)
    }),
  )
  expect(names).toContain('askModel')
  await runtime.dispose()
})
