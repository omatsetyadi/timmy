import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { makeEmbedder } from './embedder'

describe('Embedder', () => {
  it('returns a Float32Array on success', async () => {
    const e = makeEmbedder(async () => [0.1, 0.2, 0.3])
    const v = await Effect.runPromise(e.embed('hello'))
    expect(v && Array.from(v)).toEqual([0.1, 0.2, 0.3].map((n) => Math.fround(n)))
  })
  it('returns null when the embed fn yields null (unavailable)', async () => {
    const e = makeEmbedder(async () => null)
    expect(await Effect.runPromise(e.embed('hi'))).toBeNull()
  })
  it('returns null on an empty vector', async () => {
    const e = makeEmbedder(async () => [])
    expect(await Effect.runPromise(e.embed('hi'))).toBeNull()
  })
  it('returns null when the embed fn throws — never throws', async () => {
    const e = makeEmbedder(async () => {
      throw new Error('model load failed')
    })
    expect(await Effect.runPromise(e.embed('hi'))).toBeNull()
  })
})
