import { describe, it, expect } from 'vitest'
import { normalizeName, isUserRef, isAssistantRef, resolve } from './entity-resolver'

describe('normalizeName', () => {
  it('lowercases, unifies _/-, strips punctuation, collapses whitespace', () => {
    expect(normalizeName('Omat_Setyadi')).toBe('omat setyadi')
    expect(normalizeName('bedtime-target')).toBe('bedtime target')
    expect(normalizeName("User prefers 'Taylor'")).toBe('user prefers taylor')
    expect(normalizeName('  Mac   Mini  ')).toBe('mac mini')
  })
})

describe('isUserRef / isAssistantRef', () => {
  it('maps first-person + generic user terms to the user', () => {
    for (const s of ['I', 'me', 'my', 'myself', 'user', 'the user', 'User'])
      expect(isUserRef(s)).toBe(true)
    expect(isUserRef('Omat')).toBe(false) // a name resolves via alias/semantic, not the pronoun map
    expect(isUserRef('Spotify')).toBe(false)
  })
  it('maps the assistant name + generic assistant terms to the assistant', () => {
    expect(isAssistantRef('Timmy', 'Timmy')).toBe(true)
    expect(isAssistantRef('assistant', 'Timmy')).toBe(true)
    expect(isAssistantRef('the assistant', 'Timmy')).toBe(true)
    expect(isAssistantRef('Omat', 'Timmy')).toBe(false)
  })
})

const v = (...xs: number[]) => new Float32Array(xs)

describe('resolve (alias → semantic → create)', () => {
  const existing = [
    { id: 'omat', surfaces: ['omat setyadi', 'om', 'omatsetyadi'], embedding: v(1, 0, 0) },
    { id: 'spotify', surfaces: ['spotify'], embedding: v(0, 1, 0) },
  ]

  it('links on an exact alias match (precision 1.0)', () => {
    expect(resolve({ norm: 'om', vec: v(0, 0, 1) }, existing, 0.88)).toEqual({ link: 'omat' })
  })

  it('links on a high semantic match when no alias matches', () => {
    // near-identical to omat's vector, different surface form
    expect(resolve({ norm: 'mat', vec: v(0.99, 0.01, 0) }, existing, 0.88)).toEqual({
      link: 'omat',
    })
  })

  it('creates when nothing matches (low similarity, new surface)', () => {
    expect(resolve({ norm: 'kraken', vec: v(0, 0, 1) }, existing, 0.88)).toEqual({ create: true })
  })

  it('alias match wins over a weaker semantic match', () => {
    // surface "spotify" alias-matches even though its vector is closer to omat
    expect(resolve({ norm: 'spotify', vec: v(0.95, 0, 0) }, existing, 0.88)).toEqual({
      link: 'spotify',
    })
  })

  it('creates when there is no embedding and no alias match', () => {
    expect(resolve({ norm: 'newthing', vec: null }, existing, 0.88)).toEqual({ create: true })
  })
})
