import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { makeEmbedder } from './embedder'

const okPost = async () => ({ ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) })
const failPost = async () => ({ ok: false, json: async () => ({}) })
const throwPost = async () => {
  throw new Error('ECONNREFUSED')
}

describe('Embedder', () => {
  it('returns a Float32Array on success', async () => {
    const e = makeEmbedder({
      model: 'nomic-embed-text',
      baseUrl: 'http://x',
      post: okPost as never,
    })
    const v = await Effect.runPromise(e.embed('hello'))
    expect(v && Array.from(v)).toEqual([0.1, 0.2, 0.3].map((n) => Math.fround(n)))
  })
  it('returns null on a non-ok response (graceful)', async () => {
    const e = makeEmbedder({ model: 'm', baseUrl: 'http://x', post: failPost as never })
    expect(await Effect.runPromise(e.embed('hi'))).toBeNull()
  })
  it('returns null when the request throws (no Ollama) — never throws', async () => {
    const e = makeEmbedder({ model: 'm', baseUrl: 'http://x', post: throwPost as never })
    expect(await Effect.runPromise(e.embed('hi'))).toBeNull()
  })
})
