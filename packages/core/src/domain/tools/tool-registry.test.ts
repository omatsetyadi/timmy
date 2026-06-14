import { it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { expect } from 'vitest'
import type { Tool } from 'timmy-sdk'
import { ToolRegistry } from './tool-registry'
import { ToolSource } from './tool-source'

const echo: Tool = {
  name: 'echo',
  description: 'echoes',
  riskLevel: 'safe',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: async (args) => ({ ok: true, data: args.text }),
}
const layer = ToolRegistry.Live.pipe(Layer.provide(ToolSource.layer([echo])))

it.effect('lists tools, exposes model schemas, executes by name', () =>
  Effect.gen(function* () {
    const reg = yield* ToolRegistry
    expect(reg.toModelTools()[0]).toMatchObject({ type: 'function', function: { name: 'echo' } })
    const result = yield* reg.execute('echo', { text: 'hi' })
    expect(result).toEqual({ ok: true, data: 'hi' })
  }).pipe(Effect.provide(layer)),
)

it.effect('fails with ToolNotFoundError for unknown tool', () =>
  Effect.gen(function* () {
    const reg = yield* ToolRegistry
    const r = yield* Effect.either(reg.execute('nope', {}))
    expect(r._tag).toBe('Left')
  }).pipe(Effect.provide(layer)),
)
