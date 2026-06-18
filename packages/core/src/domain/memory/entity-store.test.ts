import { it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { expect } from 'vitest'
import { Db } from '../persistence/db'
import { EntityStore } from './entity-store'

const TestLayer = EntityStore.Live.pipe(Layer.provide(Db.Live(':memory:')))

it.effect('upsert inserts a new entity, returns it with an id', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const e = yield* store.upsert({
      kind: 'person',
      name: 'Omat',
      properties: { role: 'builder' },
      source: 'conversation',
    })
    expect(e.id).toBeTruthy()
    expect(e.kind).toBe('person')
    expect(e.name).toBe('Omat')
    expect(e.properties).toEqual({ role: 'builder' })
    const all = yield* store.list()
    expect(all).toHaveLength(1)
    expect(all[0].properties).toEqual({ role: 'builder' })
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('upsert by (kind,name) updates + merges properties (no duplicate row)', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const a = yield* store.upsert({ kind: 'person', name: 'Omat', properties: { role: 'builder' } })
    const b = yield* store.upsert({ kind: 'person', name: 'Omat', properties: { city: 'JKT' } })
    expect(b.id).toBe(a.id)
    const all = yield* store.list()
    expect(all).toHaveLength(1)
    expect(all[0].properties).toEqual({ role: 'builder', city: 'JKT' })
  }).pipe(Effect.provide(TestLayer)),
)

const fv = (...xs: number[]) => new Float32Array(xs)

it.effect('resolveAndUpsert creates distinct entities when nothing matches', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const a = yield* store.resolveAndUpsert({ kind: 'person', name: 'Omat' }, fv(1, 0, 0))
    const b = yield* store.resolveAndUpsert({ kind: 'tool', name: 'Spotify' }, fv(0, 1, 0))
    expect(b.id).not.toBe(a.id)
    expect(yield* store.list()).toHaveLength(2)
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('resolveAndUpsert links by normalized-name match (no duplicate)', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const a = yield* store.resolveAndUpsert({ kind: 'person', name: 'Omat Setyadi' }, null)
    const b = yield* store.resolveAndUpsert({ kind: 'person', name: 'omat_setyadi' }, null)
    expect(b.id).toBe(a.id)
    expect(yield* store.list()).toHaveLength(1)
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('resolveAndUpsert links by a learned alias', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const a = yield* store.resolveAndUpsert({ kind: 'person', name: 'Omat Setyadi' }, null)
    yield* store.addAlias(a.id, 'om')
    const b = yield* store.resolveAndUpsert({ kind: 'person', name: 'Om' }, null)
    expect(b.id).toBe(a.id)
    expect(yield* store.list()).toHaveLength(1)
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('resolveAndUpsert links by semantic match and LEARNS the new surface as an alias', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const a = yield* store.resolveAndUpsert({ kind: 'person', name: 'Omat Setyadi' }, fv(1, 0, 0))
    const b = yield* store.resolveAndUpsert({ kind: 'person', name: 'Mat' }, fv(0.99, 0.01, 0))
    expect(b.id).toBe(a.id) // near-identical vector → linked
    expect(yield* store.list()).toHaveLength(1)
    expect(b.aliases).toContain('mat') // the graph learned "mat" → Omat Setyadi
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('addAlias is idempotent and never stores the name itself', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const a = yield* store.resolveAndUpsert({ kind: 'person', name: 'Omat Setyadi' }, null)
    yield* store.addAlias(a.id, 'om')
    yield* store.addAlias(a.id, 'om')
    yield* store.addAlias(a.id, 'omat setyadi') // == normalized name → skipped
    const e = yield* store.getEntity(a.id)
    expect(e?.entity.aliases).toEqual(['om'])
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('addRelation links two entities; neighbors(1-hop) returns the other', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const omat = yield* store.upsert({ kind: 'person', name: 'Omat' })
    const jitera = yield* store.upsert({ kind: 'company', name: 'Jitera' })
    const rel = yield* store.addRelation(omat.id, 'works_at', jitera.id)
    expect(rel.from).toBe(omat.id)
    expect(rel.relation).toBe('works_at')
    expect(rel.to).toBe(jitera.id)
    const n = yield* store.neighbors([omat.id])
    expect(n.entities.map((e) => e.name)).toContain('Jitera')
    expect(n.relations.map((r) => r.id)).toContain(rel.id)
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('addRelation dedupes the same edge', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const a = yield* store.upsert({ kind: 'person', name: 'A' })
    const b = yield* store.upsert({ kind: 'person', name: 'B' })
    const r1 = yield* store.addRelation(a.id, 'knows', b.id)
    const r2 = yield* store.addRelation(a.id, 'knows', b.id)
    expect(r2.id).toBe(r1.id)
    const n = yield* store.neighbors([a.id])
    expect(n.relations).toHaveLength(1)
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('setEmbedding + allEmbedded returns the vector', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const e = yield* store.upsert({ kind: 'person', name: 'Omat' })
    yield* store.setEmbedding(e.id, new Float32Array([0.1, 0.2]))
    const embedded = yield* store.allEmbedded()
    expect(embedded).toHaveLength(1)
    expect(embedded[0].id).toBe(e.id)
    expect(Array.from(embedded[0].embedding)).toHaveLength(2)
    expect(embedded[0].embedding[0]).toBeCloseTo(0.1, 5)
    expect(embedded[0].embedding[1]).toBeCloseTo(0.2, 5)
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('getEntity returns the node + its relations', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const omat = yield* store.upsert({ kind: 'person', name: 'Omat' })
    const jitera = yield* store.upsert({ kind: 'company', name: 'Jitera' })
    yield* store.addRelation(omat.id, 'works_at', jitera.id)
    const got = yield* store.getEntity(omat.id)
    expect(got).not.toBeNull()
    expect(got!.entity.id).toBe(omat.id)
    expect(got!.relations).toHaveLength(1)
    expect(got!.relations[0].relation).toBe('works_at')
    const missing = yield* store.getEntity('nope')
    expect(missing).toBeNull()
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('list(kind) filters by kind', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    yield* store.upsert({ kind: 'person', name: 'Omat' })
    yield* store.upsert({ kind: 'company', name: 'Jitera' })
    const people = yield* store.list('person')
    expect(people.map((e) => e.name)).toEqual(['Omat'])
    const all = yield* store.list()
    expect(all).toHaveLength(2)
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('byKinds filters by multiple kinds; empty list → []', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    yield* store.upsert({ kind: 'person', name: 'Omat' })
    yield* store.upsert({ kind: 'company', name: 'Jitera' })
    yield* store.upsert({ kind: 'project', name: 'Timmy' })
    const some = yield* store.byKinds(['person', 'company'])
    expect(some.map((e) => e.name).sort()).toEqual(['Jitera', 'Omat'])
    const none = yield* store.byKinds([])
    expect(none).toEqual([])
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('update merges into existing properties', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const e = yield* store.upsert({ kind: 'person', name: 'Omat', properties: { role: 'builder' } })
    yield* store.update(e.id, { city: 'JKT' })
    const got = yield* store.getEntity(e.id)
    expect(got!.entity.properties).toEqual({ role: 'builder', city: 'JKT' })
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('neighbors with empty ids → empty', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const n = yield* store.neighbors([])
    expect(n).toEqual({ entities: [], relations: [] })
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('merge: combines properties, moves B relations to A, deletes B', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const a = yield* store.upsert({
      kind: 'person',
      name: 'Omat',
      properties: { role: 'x' },
      confidence: 0.6,
    })
    const b = yield* store.upsert({
      kind: 'person',
      name: 'Omatt',
      properties: { role: 'y', city: 'JKT' },
      confidence: 0.9,
    })
    const c = yield* store.upsert({ kind: 'company', name: 'Jitera' })
    yield* store.addRelation(b.id, 'works_at', c.id)

    const merged = yield* store.merge(a.id, b.id)
    expect(merged).not.toBeNull()
    expect(merged!.id).toBe(a.id)
    // b had higher confidence → its conflicting value wins, union of keys
    expect(merged!.properties).toEqual({ role: 'y', city: 'JKT' })
    expect(merged!.confidence).toBe(0.9)

    // B is gone
    expect(yield* store.getEntity(b.id)).toBeNull()
    const all = yield* store.list()
    expect(all.map((e) => e.id).sort()).toEqual([a.id, c.id].sort())

    // works_at rewired from B to A → A now neighbors Jitera
    const n = yield* store.neighbors([a.id])
    expect(n.entities.map((e) => e.name)).toContain('Jitera')
    expect(
      n.relations.some((r) => r.relation === 'works_at' && r.from === a.id && r.to === c.id),
    ).toBe(true)
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('merge: returns null when either entity is missing', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const a = yield* store.upsert({ kind: 'person', name: 'Omat' })
    expect(yield* store.merge(a.id, 'nope')).toBeNull()
    expect(yield* store.merge('nope', a.id)).toBeNull()
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('merge: dedupes duplicate edges and removes self-loops after rewiring', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const a = yield* store.upsert({ kind: 'person', name: 'Omat' })
    const b = yield* store.upsert({ kind: 'person', name: 'Omatt' })
    const c = yield* store.upsert({ kind: 'company', name: 'Jitera' })
    // duplicate-after-rewire: both A and B point to C with same relation
    yield* store.addRelation(a.id, 'works_at', c.id)
    yield* store.addRelation(b.id, 'works_at', c.id)
    // self-loop-after-rewire: A knows B
    yield* store.addRelation(a.id, 'knows', b.id)

    yield* store.merge(a.id, b.id)
    const n = yield* store.neighbors([a.id])
    // only one works_at edge (deduped), no self-loop knows edge
    expect(n.relations.filter((r) => r.relation === 'works_at')).toHaveLength(1)
    expect(n.relations.some((r) => r.relation === 'knows')).toBe(false)
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('upsert dedupes across kind case (person vs Person) and name case/whitespace', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    yield* store.upsert({ kind: 'Person', name: 'Omat', properties: { a: 1 } })
    yield* store.upsert({ kind: 'person', name: ' omat ', properties: { b: 2 } }) // same entity (case+trim)
    const all = yield* store.list()
    const omats = all.filter((e) => e.name.toLowerCase().trim() === 'omat')
    expect(omats.length).toBe(1)
    expect(omats[0].kind).toBe('person') // stored canonical (lowercased)
    expect(omats[0].properties).toEqual({ a: 1, b: 2 }) // merged
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('different names are NOT merged (Omat vs Omat Setyadi)', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    yield* store.upsert({ kind: 'person', name: 'Omat' })
    yield* store.upsert({ kind: 'person', name: 'Omat Setyadi' })
    expect((yield* store.list()).length).toBe(2)
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('byKinds matches regardless of stored/queried kind case', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    yield* store.upsert({ kind: 'Preference', name: 'lang' })
    expect((yield* store.byKinds(['preference'])).length).toBe(1)
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('delete removes the entity', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const e = yield* store.upsert({ kind: 'person', name: 'Omat' })
    yield* store.delete(e.id)
    const got = yield* store.getEntity(e.id)
    expect(got).toBeNull()
    expect(yield* store.list()).toHaveLength(0)
  }).pipe(Effect.provide(TestLayer)),
)

it.effect('deleteRelation removes only the relation, leaving the entities intact', () =>
  Effect.gen(function* () {
    const store = yield* EntityStore
    const omat = yield* store.upsert({ kind: 'person', name: 'Omat' })
    const jitera = yield* store.upsert({ kind: 'company', name: 'Jitera' })
    const rel = yield* store.addRelation(omat.id, 'works_at', jitera.id)
    yield* store.deleteRelation(rel.id)
    // relation is gone
    const all = yield* store.allRelations()
    expect(all.map((r) => r.id)).not.toContain(rel.id)
    const n = yield* store.neighbors([omat.id])
    expect(n.relations.map((r) => r.id)).not.toContain(rel.id)
    // both entities still exist
    expect(yield* store.getEntity(omat.id)).not.toBeNull()
    expect(yield* store.getEntity(jitera.id)).not.toBeNull()
    expect((yield* store.list()).map((e) => e.id).sort()).toEqual([omat.id, jitera.id].sort())
  }).pipe(Effect.provide(TestLayer)),
)
