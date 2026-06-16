import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { parseExtraction, makeExtractor } from './extract'

describe('parseExtraction', () => {
  it('parses entities + relations (tolerates ```json fences)', () => {
    const raw =
      '```json\n{"entities":[{"kind":"person","name":"Omat","properties":{"role":"builder"}}],"relations":[{"from":"Omat","relation":"works_at","to":"Jitera"}]}\n```'
    const g = parseExtraction(raw)
    expect(g.entities).toEqual([{ kind: 'person', name: 'Omat', properties: { role: 'builder' } }])
    expect(g.relations).toEqual([{ from: 'Omat', relation: 'works_at', to: 'Jitera' }])
  })
  it('returns an empty graph on invalid/empty/garbage input (never throws)', () => {
    expect(parseExtraction('not json')).toEqual({ entities: [], relations: [] })
    expect(parseExtraction('{}')).toEqual({ entities: [], relations: [] })
    expect(parseExtraction('{"entities":"nope"}')).toEqual({ entities: [], relations: [] })
  })
  it('drops malformed items (missing kind/name or relation fields)', () => {
    const raw =
      '{"entities":[{"kind":"person","name":"Omat"},{"name":"x"}],"relations":[{"from":"a","relation":"r","to":"b"},{"from":"a"}]}'
    const g = parseExtraction(raw)
    expect(g.entities).toEqual([{ kind: 'person', name: 'Omat', properties: {} }])
    expect(g.relations).toEqual([{ from: 'a', relation: 'r', to: 'b' }])
  })
})

describe('makeExtractor', () => {
  it('extracts → upserts entities, resolves relation endpoints by name, embeds new nodes', async () => {
    const upserts: { kind: string; name: string }[] = []
    const relations: { from: string; relation: string; to: string }[] = []
    const embedded: string[] = []
    const byId: Record<string, string> = {}
    const fakeStore = {
      upsert: (n: { kind: string; name: string }) =>
        Effect.sync(() => {
          upserts.push({ kind: n.kind, name: n.name })
          const id = `${n.kind}:${n.name}`
          byId[n.name] = id
          return {
            id,
            ...n,
            properties: {},
            confidence: 0.7,
            source: 'conversation',
            lastUpdated: '',
          }
        }),
      addRelation: (from: string, relation: string, to: string) =>
        Effect.sync(() => {
          relations.push({ from, relation, to })
          return {}
        }),
      setEmbedding: (id: string) =>
        Effect.sync(() => {
          embedded.push(id)
        }),
    }
    const fakeEmbedder = { embed: () => Effect.succeed(new Float32Array([0.1])) }
    const complete = () =>
      Effect.succeed(
        '{"entities":[{"kind":"person","name":"Omat"},{"kind":"company","name":"Jitera"}],"relations":[{"from":"Omat","relation":"works_at","to":"Jitera"}]}',
      )
    const ex = makeExtractor({
      store: fakeStore as never,
      embedder: fakeEmbedder as never,
      complete,
    })
    await Effect.runPromise(ex.extract('I work at Jitera', 'ok'))
    expect(upserts).toEqual([
      { kind: 'person', name: 'Omat' },
      { kind: 'company', name: 'Jitera' },
    ])
    expect(relations).toEqual([{ from: 'person:Omat', relation: 'works_at', to: 'company:Jitera' }]) // endpoints resolved to ids
    expect(embedded.length).toBe(2)
  })
  it('never throws on a model/parse failure (detached safety)', async () => {
    const complete = () => Effect.fail(new Error('model down'))
    const ex = makeExtractor({ store: {} as never, embedder: {} as never, complete })
    await Effect.runPromise(ex.extract('x', 'y')) // resolves, no throw
  })
})
