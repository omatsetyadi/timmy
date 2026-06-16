import { describe, it, expect } from 'vitest'
import { cosineSimilarity, topK, floatsToBuffer, bufferToFloats } from './vector'

describe('vector', () => {
  it('cosineSimilarity: identical = 1, orthogonal = 0', () => {
    const a = new Float32Array([1, 0, 0])
    expect(cosineSimilarity(a, new Float32Array([1, 0, 0]))).toBeCloseTo(1)
    expect(cosineSimilarity(a, new Float32Array([0, 1, 0]))).toBeCloseTo(0)
  })
  it('cosineSimilarity: zero vector → 0 (no NaN)', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0)
  })
  it('topK returns the k highest-scoring ids, sorted desc', () => {
    const q = new Float32Array([1, 0])
    const cands = [
      { id: 'a', embedding: new Float32Array([1, 0]) }, // 1.0
      { id: 'b', embedding: new Float32Array([0, 1]) }, // 0.0
      { id: 'c', embedding: new Float32Array([0.7, 0.7]) }, // ~0.7
    ]
    expect(topK(q, cands, 2).map((r) => r.id)).toEqual(['a', 'c'])
  })
  it('floats ↔ buffer round-trips', () => {
    const v = new Float32Array([0.1, -0.2, 0.3])
    const back = bufferToFloats(floatsToBuffer(v))
    expect(Array.from(back)).toEqual(Array.from(v))
  })
})
