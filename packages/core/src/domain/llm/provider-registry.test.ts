import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect, vi, afterEach } from 'vitest'
import { discoverModels } from './provider-registry'

afterEach(() => vi.restoreAllMocks())

it.effect('ollama discovery parses /api/tags', () =>
  Effect.gen(function* () {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'qwen3:14b' }, { name: 'qwen3:32b' }] }), {
        status: 200,
      }),
    )
    const models = yield* discoverModels('ollama', { kind: 'ollama', base_url: 'http://x' }, null)
    expect(models).toEqual(['qwen3:14b', 'qwen3:32b'])
  }),
)

it.effect('openai-compat discovery parses /models and needs the key', () =>
  Effect.gen(function* () {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }), {
        status: 200,
      }),
    )
    const models = yield* discoverModels(
      'openai',
      { kind: 'openai-compat', base_url: 'https://api.openai.com/v1' },
      'k',
    )
    expect(models).toEqual(['gpt-4o', 'gpt-4o-mini'])
  }),
)

it.effect('discovery failure → empty list, no throw', () =>
  Effect.gen(function* () {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    const models = yield* discoverModels('deepseek', { kind: 'openai-compat', base_url: 'x' }, 'k')
    expect(models).toEqual([])
  }),
)
