import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { buildMemoryTools } from './memory-tools'

const ent = (id: string, kind: string, name: string, p = {}) => ({
  id,
  kind,
  name,
  properties: p,
  confidence: 0.8,
  source: 'conversation',
  lastUpdated: '',
})

// fake store/recall impls: methods return Effects (Db already 'captured' = plain Effect.succeed)
const fakeStore = {
  list: (kind?: string) =>
    Effect.succeed(kind === undefined || kind === 'company' ? [ent('1', 'company', 'Jitera')] : []),
  getEntity: (id: string) =>
    Effect.succeed(id === '1' ? { entity: ent('1', 'company', 'Jitera'), relations: [] } : null),
  upsert: (n: never) =>
    Effect.succeed({
      id: 'new',
      ...(n as object),
      properties: {},
      confidence: 0.7,
      source: 'conversation',
      lastUpdated: '',
    }),
  update: () => Effect.succeed(undefined),
  merge: (a: string) =>
    Effect.succeed({
      id: a,
      kind: 'company',
      name: 'Jitera',
      properties: {},
      confidence: 0.9,
      source: 'conversation',
      lastUpdated: '',
    }),
  addRelation: (from: string, relation: string, to: string) =>
    Effect.succeed({ id: 'r', from, relation, to, weight: 1, createdAt: '' }),
  // record the id each delete was called with so we can assert pass-through
  deletedId: '',
  deletedRelationId: '',
  delete(id: string) {
    this.deletedId = id
    return Effect.succeed(undefined)
  },
  deleteRelation(id: string) {
    this.deletedRelationId = id
    return Effect.succeed(undefined)
  },
}
const fakeRecall = {
  forMessage: () => Effect.succeed({ block: 'x', entityNames: ['Jitera'] }),
  // record the limit it was called with so we can assert the tool passes it through
  lastSearchLimit: 0,
  search(query: string, limit: number) {
    this.lastSearchLimit = limit
    return Effect.succeed([ent('1', 'company', 'Jitera', { domain: 'jitera.com' })])
  },
}

const tools = buildMemoryTools(fakeStore as never, fakeRecall as never)
const tool = (n: string) => tools.find((t) => t.name === n)!
const ctx = {
  credentials: { get: async () => null },
  signal: new AbortController().signal,
  platform: 'mac' as const,
}

describe('buildMemoryTools', () => {
  it('exposes the 9 tools with correct risk tiers (incl. memoryList safe)', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'memoryAdd',
        'memoryDelete',
        'memoryDeleteRelation',
        'memoryGet',
        'memoryList',
        'memoryMerge',
        'memoryRelate',
        'memorySearch',
        'memoryUpdate',
      ].sort(),
    )
    expect(tool('memorySearch').riskLevel).toBe('safe')
    expect(tool('memoryGet').riskLevel).toBe('safe')
    expect(tool('memoryList').riskLevel).toBe('safe')
    expect(tool('memoryAdd').riskLevel).toBe('confirm')
    expect(tool('memoryMerge').riskLevel).toBe('confirm')
    expect(tool('memoryDelete').riskLevel).toBe('confirm')
    expect(tool('memoryDeleteRelation').riskLevel).toBe('confirm')
  })
  it('memoryDelete calls store.delete with the id and returns ok', async () => {
    const r = await tool('memoryDelete').execute({ id: 'x' }, ctx)
    expect(r.ok).toBe(true)
    expect(fakeStore.deletedId).toBe('x')
  })
  it('memoryDeleteRelation calls store.deleteRelation with the id and returns ok', async () => {
    const r = await tool('memoryDeleteRelation').execute({ id: 'r' }, ctx)
    expect(r.ok).toBe(true)
    expect(fakeStore.deletedRelationId).toBe('r')
  })
  it('memoryGet returns the node + relations', async () => {
    const r = await tool('memoryGet').execute({ id: '1' }, ctx)
    expect(r.ok).toBe(true)
    expect((r.data as { entity: { name: string } }).entity.name).toBe('Jitera')
  })
  it('memorySearch returns richer entity data (id/kind/name/properties) + count', async () => {
    const r = await tool('memorySearch').execute({ query: 'Jitera' }, ctx)
    expect(r.ok).toBe(true)
    const data = r.data as {
      entities: { id: string; kind: string; name: string; properties: Record<string, unknown> }[]
      count: number
    }
    expect(data.count).toBe(1)
    expect(data.entities[0]).toEqual({
      id: '1',
      kind: 'company',
      name: 'Jitera',
      properties: { domain: 'jitera.com' },
    })
  })
  it('memorySearch honors an explicit limit arg', async () => {
    await tool('memorySearch').execute({ query: 'Jitera', limit: 99 }, ctx)
    expect(fakeRecall.lastSearchLimit).toBe(99)
  })
  it('memorySearch falls back to the configured default limit when none given', async () => {
    await tool('memorySearch').execute({ query: 'Jitera' }, ctx)
    expect(fakeRecall.lastSearchLimit).toBe(25)
  })
  it('memoryList returns entities + total/shown/truncated', async () => {
    const r = await tool('memoryList').execute({}, ctx)
    expect(r.ok).toBe(true)
    const data = r.data as {
      entities: { id: string; kind: string; name: string }[]
      total: number
      shown: number
      truncated: boolean
    }
    expect(data.total).toBe(1)
    expect(data.shown).toBe(1)
    expect(data.truncated).toBe(false)
    expect(data.entities[0]).toEqual({ id: '1', kind: 'company', name: 'Jitera' })
  })
  it('memoryList filters by kind', async () => {
    const r = await tool('memoryList').execute({ kind: 'person' }, ctx)
    expect(r.ok).toBe(true)
    expect((r.data as { total: number }).total).toBe(0)
  })
  it('memoryList truncates explicitly (truncated:true + total) when over the cap', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ent(String(i), 'company', `C${i}`))
    const bigStore = { ...fakeStore, list: () => Effect.succeed(many) }
    const t = buildMemoryTools(bigStore as never, fakeRecall as never, {
      searchLimit: 25,
      listCap: 2,
    })
    const r = await t.find((x) => x.name === 'memoryList')!.execute({}, ctx)
    expect(r.ok).toBe(true)
    const data = r.data as { entities: unknown[]; total: number; shown: number; truncated: boolean }
    expect(data.total).toBe(5)
    expect(data.shown).toBe(2)
    expect(data.entities.length).toBe(2)
    expect(data.truncated).toBe(true)
  })
  it('memoryMerge calls merge and returns ok', async () => {
    const r = await tool('memoryMerge').execute({ idA: '1', idB: '2' }, ctx)
    expect(r.ok).toBe(true)
  })
})
