import { describe, it, expect } from 'vitest'
import { mergeProperties, mergeEntities } from './merge'
import type { Entity } from './types'

const ent = (over: Partial<Entity>): Entity => ({
  id: 'x',
  kind: 'person',
  name: 'Omat',
  properties: {},
  confidence: 0.7,
  source: 'conversation',
  lastUpdated: '2026-01-01',
  ...over,
})

describe('merge', () => {
  it('mergeProperties: union; bWins decides key conflicts', () => {
    expect(mergeProperties({ a: 1, b: 2 }, { b: 9, c: 3 }, true)).toEqual({ a: 1, b: 9, c: 3 })
    expect(mergeProperties({ a: 1, b: 2 }, { b: 9, c: 3 }, false)).toEqual({ a: 1, b: 2, c: 3 })
  })
  it('mergeEntities keeps A.id, unions properties (higher-confidence/newer wins), max confidence, latest lastUpdated', () => {
    const a = ent({
      id: 'a',
      properties: { role: 'x' },
      confidence: 0.6,
      lastUpdated: '2026-01-01',
    })
    const b = ent({
      id: 'b',
      properties: { role: 'y', city: 'JKT' },
      confidence: 0.9,
      lastUpdated: '2026-02-01',
    })
    const m = mergeEntities(a, b)
    expect(m.id).toBe('a')
    expect(m.properties).toEqual({ role: 'y', city: 'JKT' }) // b wins (higher conf): role→y
    expect(m.confidence).toBe(0.9)
    expect(m.lastUpdated).toBe('2026-02-01')
  })
  it('mergeEntities: A wins on conflict when A has higher confidence', () => {
    const a = ent({ id: 'a', properties: { role: 'x' }, confidence: 0.9 })
    const b = ent({ id: 'b', properties: { role: 'y' }, confidence: 0.5 })
    expect(mergeEntities(a, b).properties).toEqual({ role: 'x' })
  })
})
