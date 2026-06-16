import { Context, Effect, Layer } from 'effect'
import { Config } from '../config/config'
import { Embedder } from './embedder'
import { EntityStore } from './entity-store'
import type { Entity, Relation } from './types'
import { topK } from './vector'

const CONTEXT_BLOCK_HEADING = '## What you know about the user'

/** Render the recalled subgraph as a "What you know" context block, or '' if no entities.
 *  Relations whose endpoints aren't in `entities` are skipped (ids resolved to names). */
export function composeContextBlock(entities: Entity[], relations: Relation[]): string {
  if (entities.length === 0) return ''
  const nameById = new Map(entities.map((e) => [e.id, e.name]))
  const lines: string[] = [CONTEXT_BLOCK_HEADING]
  for (const e of entities) {
    const props = Object.entries(e.properties)
    const propStr =
      props.length > 0 ? ` {${props.map(([k, v]) => `${k}: ${String(v)}`).join(', ')}}` : ''
    lines.push(`- ${e.kind}: ${e.name}${propStr}`)
  }
  const relLines: string[] = []
  for (const r of relations) {
    const from = nameById.get(r.from)
    const to = nameById.get(r.to)
    if (from === undefined || to === undefined) continue
    relLines.push(`- ${from} --${r.relation}--> ${to}`)
  }
  if (relLines.length > 0) {
    lines.push('relations:')
    lines.push(...relLines)
  }
  return lines.join('\n')
}

/** Build the final, budgeted recall set:
 *  alwaysOn (never dropped) → seeds (score desc) → neighbors; deduped by id (first wins);
 *  capped to max(budget, alwaysOn.length) so always-on survives a tight budget. */
export function rankAndCap(
  alwaysOn: Entity[],
  seeds: { entity: Entity; score: number }[],
  neighbors: Entity[],
  budget: number,
): Entity[] {
  const sortedSeeds = [...seeds].sort((a, b) => b.score - a.score).map((s) => s.entity)
  const ordered = [...alwaysOn, ...sortedSeeds, ...neighbors]
  const seen = new Set<string>()
  const deduped: Entity[] = []
  for (const e of ordered) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    deduped.push(e)
  }
  const cap = Math.max(budget, alwaysOn.length)
  return deduped.slice(0, cap)
}

export interface RecallResult {
  block: string
  entityNames: string[]
}

export interface RecallImpl {
  readonly forMessage: (message: string) => Effect.Effect<RecallResult>
  /** Broader EXPLICIT search (the agent asked): NOT budgeted, NO neighbors, NO always-on.
   *  Embed the query → topK over embedded entities → full matched entities; keyword fallback
   *  (name substring) if embedding is unavailable. Distinct from the silent `forMessage`. */
  readonly search: (query: string, limit: number) => Effect.Effect<Entity[]>
}

export class Recall extends Context.Tag('timmy/memory/recall')<Recall, RecallImpl>() {
  static Live = Layer.effect(
    Recall,
    Effect.gen(function* () {
      const config = yield* Config
      const store = yield* EntityStore
      const embedder = yield* Embedder

      const forMessage = (message: string) =>
        Effect.gen(function* () {
          const cfg = yield* config.get
          const all = yield* store.list()
          const alwaysOn = yield* store.byKinds(cfg.memory.always_kinds)

          const vec = yield* embedder.embed(message)
          let seeds: { entity: Entity; score: number }[]
          if (vec) {
            const cands = all
              .filter((e) => e.embedding)
              .map((e) => ({ id: e.id, embedding: e.embedding! }))
            const scored = topK(vec, cands, cfg.memory.recall_limit)
            const byId = new Map(all.map((e) => [e.id, e]))
            seeds = scored
              .map((s) => {
                const entity = byId.get(s.id)
                return entity ? { entity, score: s.score } : null
              })
              .filter((s): s is { entity: Entity; score: number } => s !== null)
          } else {
            const lower = message.toLowerCase()
            seeds = all
              .filter((e) => lower.includes(e.name.toLowerCase()))
              .slice(0, cfg.memory.recall_limit)
              .map((e) => ({ entity: e, score: 1 }))
          }

          const nb = yield* store.neighbors(seeds.map((s) => s.entity.id))
          const ranked = rankAndCap(alwaysOn, seeds, nb.entities, cfg.memory.recall_budget)
          const block = composeContextBlock(ranked, nb.relations)
          return { block, entityNames: ranked.map((e) => e.name) }
        }).pipe(Effect.catchAll(() => Effect.succeed({ block: '', entityNames: [] as string[] })))

      const search = (query: string, limit: number) =>
        Effect.gen(function* () {
          const all = yield* store.list()
          const vec = yield* embedder.embed(query)
          if (vec) {
            const cands = all
              .filter((e) => e.embedding)
              .map((e) => ({ id: e.id, embedding: e.embedding! }))
            const scored = topK(vec, cands, limit)
            const byId = new Map(all.map((e) => [e.id, e]))
            return scored.map((s) => byId.get(s.id)).filter((e): e is Entity => e !== undefined)
          }
          const lower = query.toLowerCase()
          return all.filter((e) => e.name.toLowerCase().includes(lower)).slice(0, limit)
        }).pipe(Effect.catchAll(() => Effect.succeed([] as Entity[])))

      return { forMessage, search }
    }),
  )
}
