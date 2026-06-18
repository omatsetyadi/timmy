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
  const fakeStore = (
    upserts: { kind: string; name: string }[],
    relations: { from: string; relation: string; to: string }[] = [],
    embeds: (Float32Array | null)[] = [],
  ) => ({
    resolveAndUpsert: (n: { kind: string; name: string }, vec: Float32Array | null) =>
      Effect.sync(() => {
        upserts.push({ kind: n.kind, name: n.name })
        embeds.push(vec)
        return {
          id: `${n.kind}:${n.name}`,
          kind: n.kind,
          name: n.name,
          properties: {},
          confidence: 0.7,
          source: 'conversation' as const,
          lastUpdated: '',
          aliases: [],
        }
      }),
    addRelation: (from: string, relation: string, to: string) =>
      Effect.sync(() => {
        relations.push({ from, relation, to })
        return {}
      }),
  })
  const fakeEmbedder = { embed: () => Effect.succeed(new Float32Array([0.1])) }

  it('resolves entities, resolves relation endpoints by id, embeds each candidate', async () => {
    const upserts: { kind: string; name: string }[] = []
    const relations: { from: string; relation: string; to: string }[] = []
    const embeds: (Float32Array | null)[] = []
    const ex = makeExtractor({
      store: fakeStore(upserts, relations, embeds) as never,
      embedder: fakeEmbedder as never,
      complete: () =>
        Effect.succeed(
          '{"entities":[{"kind":"person","name":"Omat"},{"kind":"company","name":"Jitera"}],"relations":[{"from":"Omat","relation":"works_at","to":"Jitera"}]}',
        ),
      userName: 'Omat',
      assistantName: 'Timmy',
    })
    await Effect.runPromise(ex.extract('I work at Jitera', 'ok'))
    expect(upserts).toEqual([
      { kind: 'person', name: 'Omat' },
      { kind: 'company', name: 'Jitera' },
    ])
    expect(relations).toEqual([{ from: 'person:Omat', relation: 'works_at', to: 'company:Jitera' }])
    expect(embeds).toHaveLength(2) // each candidate embedded for semantic resolution
  })

  it('coreference: "I" / "the user" collapse onto the canonical user name', async () => {
    const upserts: { kind: string; name: string }[] = []
    const ex = makeExtractor({
      store: fakeStore(upserts) as never,
      embedder: { embed: () => Effect.succeed(null) } as never,
      complete: () =>
        Effect.succeed(
          '{"entities":[{"kind":"person","name":"I"},{"kind":"person","name":"the user"}],"relations":[]}',
        ),
      userName: 'Omat',
      assistantName: 'Timmy',
    })
    await Effect.runPromise(ex.extract('hi', 'ok'))
    expect(upserts.map((u) => u.name)).toEqual(['Omat', 'Omat']) // never spawn a new "I"/"the user"
  })

  it('never throws on a model/parse failure (detached safety)', async () => {
    const ex = makeExtractor({
      store: {} as never,
      embedder: {} as never,
      complete: () => Effect.fail(new Error('model down')),
      userName: 'U',
      assistantName: 'A',
    })
    await Effect.runPromise(ex.extract('x', 'y')) // resolves, no throw
  })
})
