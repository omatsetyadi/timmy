import { Effect } from 'effect'
import type { EmbedderImpl } from './embedder'
import type { EntityStore } from './entity-store'
import type { ExtractedGraph } from './types'

/** Kind used for relation endpoints that weren't among the extracted entities. */
const FALLBACK_ENTITY_KIND = 'concept'

export const EXTRACTION_PROMPT = `You extract a knowledge graph from a single conversation exchange.

Output JSON ONLY (no prose, no markdown fences) of the shape:
{"entities":[{"kind":"<type>","name":"<name>","properties":{}}],"relations":[{"from":"<name>","relation":"<verb>","to":"<name>","properties":{}}]}

Rules:
- "entities" are the durable things mentioned: people, companies, projects, tools, places, preferences, facts.
- "relations" connect entity NAMES (from/to must match an entity name).
- Reify any attributed or n-ary relationship into its OWN node instead of cramming details onto an edge. Examples: a Job (with role, start date) that links a person and a company; a Holding (with quantity, price) that links an owner and an asset; a Rule/preference (with scope, value) that a person holds. Then connect the reified node to its participants with simple relations.
- Put qualifiers (dates, roles, amounts, confidence) in "properties", never invent them.
- Extract only what is stated; emit empty arrays if nothing durable is present.

The material is the following exchange:`

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isString = (v: unknown): v is string => typeof v === 'string'

/** Strip ```json / ``` fences and surrounding whitespace. */
const stripFences = (raw: string): string => {
  const trimmed = raw.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/)
  return (fenceMatch ? fenceMatch[1] : trimmed).trim()
}

/**
 * Pure: model JSON → validated graph. Strips fences, parses, validates, and drops
 * malformed items. Never throws — returns an empty graph on any error.
 */
export function parseExtraction(raw: string): ExtractedGraph {
  const empty: ExtractedGraph = { entities: [], relations: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(raw))
  } catch {
    return empty
  }
  if (!isRecord(parsed)) return empty

  const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : []
  const rawRelations = Array.isArray(parsed.relations) ? parsed.relations : []

  const entities: ExtractedGraph['entities'] = []
  for (const e of rawEntities) {
    if (!isRecord(e) || !isString(e.kind) || !isString(e.name)) continue
    entities.push({
      kind: e.kind,
      name: e.name,
      properties: isRecord(e.properties) ? e.properties : {},
    })
  }

  const relations: ExtractedGraph['relations'] = []
  for (const r of rawRelations) {
    if (!isRecord(r) || !isString(r.from) || !isString(r.relation) || !isString(r.to)) continue
    const rel: ExtractedGraph['relations'][number] = {
      from: r.from,
      relation: r.relation,
      to: r.to,
    }
    if (isRecord(r.properties)) rel.properties = r.properties
    relations.push(rel)
  }

  return { entities, relations }
}

export interface MakeExtractorDeps {
  readonly store: Pick<
    Effect.Effect.Success<typeof EntityStore>,
    'upsert' | 'addRelation' | 'setEmbedding'
  >
  readonly embedder: Pick<EmbedderImpl, 'embed'>
  readonly complete: (prompt: string) => Effect.Effect<string, unknown>
}

export interface ExtractorImpl {
  /** Extract a graph from one exchange and persist it. Never fails (runs detached post-turn). */
  readonly extract: (userMsg: string, assistantMsg: string) => Effect.Effect<void>
}

/**
 * Injectable factory: given a store, embedder, and model `complete`, builds an extractor
 * that extracts → upserts entities → resolves & adds relations → embeds new nodes.
 * The whole pipeline is wrapped so it NEVER fails.
 */
export function makeExtractor(deps: MakeExtractorDeps): ExtractorImpl {
  const { store, embedder, complete } = deps

  const extract = (userMsg: string, assistantMsg: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const prompt = `${EXTRACTION_PROMPT}\nUser: ${userMsg}\nAssistant: ${assistantMsg}`
      const raw = yield* complete(prompt)
      const graph = parseExtraction(raw)

      const idByName = new Map<string, string>()
      const newlyUpserted: { id: string; name: string; properties: Record<string, unknown> }[] = []

      const upsertNode = (kind: string, name: string, properties: Record<string, unknown>) =>
        Effect.gen(function* () {
          const entity = yield* store.upsert({ kind, name, properties })
          idByName.set(name, entity.id)
          newlyUpserted.push({ id: entity.id, name, properties })
          return entity.id
        })

      for (const e of graph.entities) {
        yield* upsertNode(e.kind, e.name, e.properties ?? {})
      }

      for (const r of graph.relations) {
        const fromId = idByName.get(r.from) ?? (yield* upsertNode(FALLBACK_ENTITY_KIND, r.from, {}))
        const toId = idByName.get(r.to) ?? (yield* upsertNode(FALLBACK_ENTITY_KIND, r.to, {}))
        yield* store.addRelation(fromId, r.relation, toId, r.properties)
      }

      for (const node of newlyUpserted) {
        const vec = yield* embedder.embed(`${node.name} ${JSON.stringify(node.properties)}`)
        if (vec !== null) yield* store.setEmbedding(node.id, vec)
      }
    }).pipe(Effect.catchAll(() => Effect.void))

  return { extract }
}
