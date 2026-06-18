import { Context, Effect, Layer, Stream } from 'effect'
import { Config } from '../config/config'
import { LlmClient } from '../llm/llm-client'
import { Embedder, type EmbedderImpl } from './embedder'
import { EntityStore } from './entity-store'
import { isAssistantRef, isUserRef } from './entity-resolver'
import type { ExtractedGraph } from './types'

/** Kind used for relation endpoints that weren't among the extracted entities. */
const FALLBACK_ENTITY_KIND = 'concept'

export const EXTRACTION_PROMPT = `You extract a knowledge graph from a single conversation exchange.

Output JSON ONLY (no prose, no markdown fences) of the shape:
{"entities":[{"kind":"<type>","name":"<name>","properties":{}}],"relations":[{"from":"<name>","relation":"<verb>","to":"<name>","properties":{}}]}

Rules:
- "entities" are the durable things mentioned: people, companies, projects, tools, places, preferences, facts.
- "relations" connect entity NAMES (from/to must match an entity name).
- "kind" MUST be lowercase + singular + from a consistent vocabulary (person, company, project, tool, stock, holding, job, rule, preference, place). Never vary the case (always "person", never "Person").
- Use ONE canonical name per real thing and reuse it exactly. If the user is "Omat Setyadi" also called "Omat", pick the fullest form ("Omat Setyadi") as the name and put the nickname in properties — do NOT create a separate "Omat" entity. Never split one real thing into multiple entities.
- Reify any attributed or n-ary relationship into its OWN node instead of cramming details onto an edge. Examples: a Job (with role, start date) that links a person and a company; a Holding (with quantity, price) that links an owner and an asset; a Rule/preference (with scope, value) that a person holds. Then connect the reified node to its participants with simple relations.
- Put qualifiers (dates, roles, amounts) in "properties", never invent them.
- Extract REAL-WORLD facts only. Do NOT emit meta/process relations (e.g. "merged_into", "is_about", "knows_via") or anything describing the assistant's own actions or this conversation — only what is true about the user and their world.
- The user's own identity/preferences (name, nickname, language, how to address them) → store on a single person entity, and use kind "preference" for standalone preference facts (these are always-on context).
- Extract only what is stated; emit empty arrays if nothing durable is present. Prefer FEW high-confidence entities over many speculative ones.

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
    'resolveAndUpsert' | 'addRelation'
  >
  readonly embedder: Pick<EmbedderImpl, 'embed'>
  readonly complete: (prompt: string) => Effect.Effect<string, unknown>
  /** Canonical names that coreference maps to — so "I/me/the user" → the one user entity, and the
   *  assistant's name / "assistant" → the one assistant entity. From the profile. */
  readonly userName: string
  readonly assistantName: string
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
  const { store, embedder, complete, userName, assistantName } = deps

  // Coreference: collapse first-person / generic-user / assistant references onto the canonical names
  // BEFORE resolution, so "I", "me", "the user" never spawn a new person — they enrich the one you.
  const canonical = (name: string): string =>
    isUserRef(name) ? userName : isAssistantRef(name, assistantName) ? assistantName : name

  const extract = (userMsg: string, assistantMsg: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const prompt = `${EXTRACTION_PROMPT}\nUser: ${userMsg}\nAssistant: ${assistantMsg}`
      const raw = yield* complete(prompt)
      const graph = parseExtraction(raw)

      // Map the RAW extracted name → the resolved canonical id, so relations link correctly even
      // after coreference/dedup rewrites the entity.
      const idByName = new Map<string, string>()

      const upsertNode = (kind: string, rawName: string, properties: Record<string, unknown>) =>
        Effect.gen(function* () {
          const name = canonical(rawName)
          // Embed the NAME ONLY for identity matching — props vary and would drown out the name,
          // wrecking resolution. null → alias-only matching.
          const vec = yield* embedder.embed(name)
          const entity = yield* store.resolveAndUpsert({ kind, name, properties }, vec)
          idByName.set(rawName, entity.id)
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
    }).pipe(Effect.catchAll(() => Effect.void))

  return { extract }
}

/**
 * Live extractor service: binds `makeExtractor` to the resolved EntityStore + Embedder and a
 * `complete` that runs the frontdesk LlmClient on a one-shot user message and folds its
 * `content` chunks into a single string. The extractor impl is already catchAll-wrapped, so
 * `extract` never fails — safe to fire detached post-turn.
 */
export class Extractor extends Context.Tag('timmy/memory/extractor')<Extractor, ExtractorImpl>() {
  static Live = Layer.effect(
    Extractor,
    Effect.gen(function* () {
      const store = yield* EntityStore
      const embedder = yield* Embedder
      const llm = yield* LlmClient
      const cfg = yield* (yield* Config).get
      const complete = (prompt: string) =>
        llm
          .chat([{ role: 'user', content: prompt }])
          .pipe(
            Stream.runFold('', (acc, chunk) =>
              chunk.type === 'content' ? acc + chunk.content : acc,
            ),
          )
      return makeExtractor({
        store,
        embedder,
        complete,
        userName: cfg.user?.name?.trim() || 'the user',
        assistantName: cfg.assistant.name,
      })
    }),
  )
}
