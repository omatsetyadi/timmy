import { Context, Effect, Layer } from 'effect'
import { randomUUID } from 'node:crypto'
import { Db } from '../persistence/db'
import type { SqlError } from '../persistence/errors'
import { mergeEntities } from './merge'
import { normalizeName, resolve } from './entity-resolver'
import type { Entity, Relation } from './types'
import { bufferToFloats, floatsToBuffer } from './vector'

/** Semantic auto-link bar for entity resolution. Strict — false fuses corrupt the graph; the
 *  (exact) alias path + accumulating aliases carry most dedup, so the fuzzy step can be conservative. */
const RESOLVE_THRESHOLD = 0.75

interface EntityRow {
  id: string
  kind: string
  name: string
  properties: string | null
  embedding: Buffer | null
  confidence: number
  source: string | null
  last_updated: string
  expires_at: string | null
  aliases: string | null
}

interface RelationRow {
  id: string
  from_entity: string
  relation: string
  to_entity: string
  properties: string | null
  weight: number
  created_at: string
}

export interface UpsertInput {
  kind: string
  name: string
  properties?: Record<string, unknown>
  confidence?: number
  source?: Entity['source']
  expiresAt?: string | null
}

const ENTITY_SOURCE_DEFAULT: Entity['source'] = 'conversation'

const rowToEntity = (r: EntityRow): Entity => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  properties: r.properties ? (JSON.parse(r.properties) as Record<string, unknown>) : {},
  embedding: r.embedding ? bufferToFloats(r.embedding) : null,
  confidence: r.confidence,
  source: (r.source ?? ENTITY_SOURCE_DEFAULT) as Entity['source'],
  lastUpdated: r.last_updated,
  expiresAt: r.expires_at,
  aliases: r.aliases ? (JSON.parse(r.aliases) as string[]) : [],
})

const rowToRelation = (r: RelationRow): Relation => ({
  id: r.id,
  from: r.from_entity,
  relation: r.relation,
  to: r.to_entity,
  properties: r.properties ? (JSON.parse(r.properties) as Record<string, unknown>) : undefined,
  weight: r.weight,
  createdAt: r.created_at,
})

export class EntityStore extends Context.Tag('timmy/memory/entity-store')<
  EntityStore,
  {
    readonly upsert: (node: UpsertInput) => Effect.Effect<Entity, SqlError>
    /** Resolve a proposed entity against the existing graph (alias → semantic → create) and write:
     *  link+enrich an existing canonical (learning the new surface as an alias), or create a new one.
     *  `vec` = the candidate's embedding (caller embeds; null disables the semantic step). */
    readonly resolveAndUpsert: (
      node: UpsertInput,
      vec: Float32Array | null,
    ) => Effect.Effect<Entity, SqlError>
    /** Record an extra surface form for an entity (no-op if already its name or a known alias). */
    readonly addAlias: (id: string, alias: string) => Effect.Effect<void, SqlError>
    readonly setEmbedding: (id: string, vec: Float32Array) => Effect.Effect<void, SqlError>
    readonly addRelation: (
      from: string,
      relation: string,
      to: string,
      properties?: Record<string, unknown>,
    ) => Effect.Effect<Relation, SqlError>
    readonly allEmbedded: () => Effect.Effect<{ id: string; embedding: Float32Array }[], SqlError>
    readonly byKinds: (kinds: string[]) => Effect.Effect<Entity[], SqlError>
    readonly neighbors: (
      ids: string[],
      depth?: number,
    ) => Effect.Effect<{ entities: Entity[]; relations: Relation[] }, SqlError>
    readonly getEntity: (
      id: string,
    ) => Effect.Effect<{ entity: Entity; relations: Relation[] } | null, SqlError>
    readonly list: (kind?: string) => Effect.Effect<Entity[], SqlError>
    readonly allRelations: () => Effect.Effect<Relation[], SqlError>
    readonly update: (
      id: string,
      properties: Record<string, unknown>,
    ) => Effect.Effect<void, SqlError>
    readonly delete: (id: string) => Effect.Effect<void, SqlError>
    readonly deleteRelation: (id: string) => Effect.Effect<void, SqlError>
    readonly merge: (idA: string, idB: string) => Effect.Effect<Entity | null, SqlError>
  }
>() {
  static Live = Layer.effect(
    EntityStore,
    Effect.gen(function* () {
      const db = yield* Db
      const now = () => new Date().toISOString()

      const getRow = (id: string) => db.get<EntityRow>('SELECT * FROM entities WHERE id = ?', [id])

      const relationsFor = (id: string) =>
        db.query<RelationRow>('SELECT * FROM relations WHERE from_entity = ? OR to_entity = ?', [
          id,
          id,
        ])

      const upsert = (node: UpsertInput) =>
        Effect.gen(function* () {
          const newProps = node.properties ?? {}
          const kind = node.kind.trim().toLowerCase()
          const name = node.name.trim()
          const existing = yield* db.get<EntityRow>(
            'SELECT id, properties FROM entities WHERE kind = ? AND name = ? COLLATE NOCASE',
            [kind, name],
          )
          if (existing) {
            const existingProps = existing.properties
              ? (JSON.parse(existing.properties) as Record<string, unknown>)
              : {}
            const merged = { ...existingProps, ...newProps }
            const t = now()
            if (node.confidence !== undefined) {
              yield* db.run(
                'UPDATE entities SET properties = ?, last_updated = ?, confidence = ? WHERE id = ?',
                [JSON.stringify(merged), t, node.confidence, existing.id],
              )
            } else {
              yield* db.run('UPDATE entities SET properties = ?, last_updated = ? WHERE id = ?', [
                JSON.stringify(merged),
                t,
                existing.id,
              ])
            }
            const row = yield* getRow(existing.id)
            return rowToEntity(row!)
          }
          const id = randomUUID()
          const t = now()
          yield* db.run(
            'INSERT INTO entities (id,kind,name,properties,confidence,source,last_updated,expires_at) VALUES (?,?,?,?,?,?,?,?)',
            [
              id,
              kind,
              name,
              JSON.stringify(newProps),
              node.confidence ?? 0.7,
              node.source ?? ENTITY_SOURCE_DEFAULT,
              t,
              node.expiresAt ?? null,
            ],
          )
          const row = yield* getRow(id)
          return rowToEntity(row!)
        })

      const setEmbedding = (id: string, vec: Float32Array) =>
        db.run('UPDATE entities SET embedding = ? WHERE id = ?', [floatsToBuffer(vec), id])

      const addAlias = (id: string, alias: string) =>
        Effect.gen(function* () {
          if (!alias) return
          const row = yield* getRow(id)
          if (!row) return
          const cur = row.aliases ? (JSON.parse(row.aliases) as string[]) : []
          // The name is always an implicit surface — don't store it (or a known alias) as an alias.
          if (new Set([normalizeName(row.name), ...cur]).has(alias)) return
          cur.push(alias)
          yield* db.run('UPDATE entities SET aliases = ? WHERE id = ?', [JSON.stringify(cur), id])
        })

      const resolveAndUpsert = (node: UpsertInput, vec: Float32Array | null) =>
        Effect.gen(function* () {
          const norm = normalizeName(node.name)
          const rows = yield* db.query<EntityRow>(
            'SELECT id, name, embedding, aliases FROM entities',
            [],
          )
          const existing = rows.map((r) => ({
            id: r.id,
            surfaces: [
              normalizeName(r.name),
              ...(r.aliases ? (JSON.parse(r.aliases) as string[]) : []),
            ],
            embedding: r.embedding ? bufferToFloats(r.embedding) : null,
          }))
          const decision = resolve({ norm, vec }, existing, RESOLVE_THRESHOLD)
          const t = now()

          if ('link' in decision) {
            const row = yield* getRow(decision.link)
            if (row) {
              const existingProps = row.properties
                ? (JSON.parse(row.properties) as Record<string, unknown>)
                : {}
              const merged = { ...existingProps, ...(node.properties ?? {}) }
              yield* db.run('UPDATE entities SET properties = ?, last_updated = ? WHERE id = ?', [
                JSON.stringify(merged),
                t,
                decision.link,
              ])
              if (!row.embedding && vec)
                yield* db.run('UPDATE entities SET embedding = ? WHERE id = ?', [
                  floatsToBuffer(vec),
                  decision.link,
                ])
              yield* addAlias(decision.link, norm) // learn the surface (no-op if it's the name)
              const updated = yield* getRow(decision.link)
              return rowToEntity(updated!)
            }
          }

          const id = randomUUID()
          yield* db.run(
            'INSERT INTO entities (id,kind,name,properties,embedding,confidence,source,last_updated,expires_at,aliases) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [
              id,
              node.kind.trim().toLowerCase(),
              node.name.trim(),
              JSON.stringify(node.properties ?? {}),
              vec ? floatsToBuffer(vec) : null,
              node.confidence ?? 0.7,
              node.source ?? ENTITY_SOURCE_DEFAULT,
              t,
              node.expiresAt ?? null,
              JSON.stringify([]),
            ],
          )
          const row = yield* getRow(id)
          return rowToEntity(row!)
        })

      const addRelation = (
        from: string,
        relation: string,
        to: string,
        properties?: Record<string, unknown>,
      ) =>
        Effect.gen(function* () {
          const existing = yield* db.get<RelationRow>(
            'SELECT * FROM relations WHERE from_entity = ? AND relation = ? AND to_entity = ?',
            [from, relation, to],
          )
          if (existing) return rowToRelation(existing)
          const id = randomUUID()
          const t = now()
          yield* db.run(
            'INSERT INTO relations (id,from_entity,relation,to_entity,properties,weight,created_at) VALUES (?,?,?,?,?,?,?)',
            [id, from, relation, to, properties ? JSON.stringify(properties) : null, 1.0, t],
          )
          const row = yield* db.get<RelationRow>('SELECT * FROM relations WHERE id = ?', [id])
          return rowToRelation(row!)
        })

      const allEmbedded = () =>
        db
          .query<EntityRow>('SELECT id, embedding FROM entities WHERE embedding IS NOT NULL', [])
          .pipe(
            Effect.map((rows) =>
              rows.map((r) => ({ id: r.id, embedding: bufferToFloats(r.embedding!) })),
            ),
          )

      const byKinds = (kinds: string[]) => {
        const normalized = kinds.map((k) => k.trim().toLowerCase())
        return normalized.length === 0
          ? Effect.succeed([] as Entity[])
          : db
              .query<EntityRow>(
                `SELECT * FROM entities WHERE kind IN (${normalized.map(() => '?').join(',')})`,
                normalized,
              )
              .pipe(Effect.map((rows) => rows.map(rowToEntity)))
      }

      // Direct (1-hop) neighbors of `ids` plus the relations connecting them.
      const neighbors = (ids: string[]) =>
        Effect.gen(function* () {
          if (ids.length === 0) return { entities: [] as Entity[], relations: [] as Relation[] }
          const placeholders = ids.map(() => '?').join(',')
          const rels = yield* db.query<RelationRow>(
            `SELECT * FROM relations WHERE from_entity IN (${placeholders}) OR to_entity IN (${placeholders})`,
            [...ids, ...ids],
          )
          const connected = new Set<string>()
          for (const r of rels) {
            connected.add(r.from_entity)
            connected.add(r.to_entity)
          }
          for (const id of ids) connected.delete(id)
          const entityIds = [...connected]
          const entities =
            entityIds.length === 0
              ? []
              : (yield* db.query<EntityRow>(
                  `SELECT * FROM entities WHERE id IN (${entityIds.map(() => '?').join(',')})`,
                  entityIds,
                )).map(rowToEntity)
          return { entities, relations: rels.map(rowToRelation) }
        })

      const getEntity = (id: string) =>
        Effect.gen(function* () {
          const row = yield* getRow(id)
          if (!row) return null
          const rels = yield* relationsFor(id)
          return { entity: rowToEntity(row), relations: rels.map(rowToRelation) }
        })

      const list = (kind?: string) => {
        const normalized = kind?.trim().toLowerCase()
        return (
          normalized === undefined || normalized === ''
            ? db.query<EntityRow>('SELECT * FROM entities', [])
            : db.query<EntityRow>('SELECT * FROM entities WHERE kind = ?', [normalized])
        ).pipe(Effect.map((rows) => rows.map(rowToEntity)))
      }

      const allRelations = () =>
        db
          .query<RelationRow>('SELECT * FROM relations', [])
          .pipe(Effect.map((rows) => rows.map(rowToRelation)))

      const update = (id: string, properties: Record<string, unknown>) =>
        Effect.gen(function* () {
          const row = yield* db.get<EntityRow>('SELECT properties FROM entities WHERE id = ?', [id])
          const existingProps = row?.properties
            ? (JSON.parse(row.properties) as Record<string, unknown>)
            : {}
          const merged = { ...existingProps, ...properties }
          yield* db.run('UPDATE entities SET properties = ?, last_updated = ? WHERE id = ?', [
            JSON.stringify(merged),
            now(),
            id,
          ])
        })

      const del = (id: string) => db.run('DELETE FROM entities WHERE id = ?', [id])

      const deleteRelation = (id: string) => db.run('DELETE FROM relations WHERE id = ?', [id])

      const merge = (idA: string, idB: string) =>
        Effect.gen(function* () {
          const rowA = yield* getRow(idA)
          const rowB = yield* getRow(idB)
          if (!rowA || !rowB) return null

          const merged = mergeEntities(rowToEntity(rowA), rowToEntity(rowB))
          yield* db.run(
            'UPDATE entities SET properties = ?, confidence = ?, last_updated = ? WHERE id = ?',
            [JSON.stringify(merged.properties), merged.confidence, merged.lastUpdated, idA],
          )

          // Rewire B's relations onto A.
          yield* db.run('UPDATE relations SET from_entity = ? WHERE from_entity = ?', [idA, idB])
          yield* db.run('UPDATE relations SET to_entity = ? WHERE to_entity = ?', [idA, idB])
          // Drop self-loops created by the rewire.
          yield* db.run('DELETE FROM relations WHERE from_entity = to_entity', [])
          // Dedupe exact (from,relation,to) edges, keeping the lowest id.
          const dupes = yield* db.query<RelationRow>(
            'SELECT * FROM relations WHERE from_entity = ? OR to_entity = ?',
            [idA, idA],
          )
          const seen = new Set<string>()
          for (const r of dupes) {
            const key = `${r.from_entity} ${r.relation} ${r.to_entity}`
            if (seen.has(key)) {
              yield* db.run('DELETE FROM relations WHERE id = ?', [r.id])
            } else {
              seen.add(key)
            }
          }

          yield* db.run('DELETE FROM entities WHERE id = ?', [idB])
          const row = yield* getRow(idA)
          return row ? rowToEntity(row) : null
        })

      return {
        upsert,
        resolveAndUpsert,
        addAlias,
        setEmbedding,
        addRelation,
        allEmbedded,
        byKinds,
        neighbors,
        getEntity,
        list,
        allRelations,
        update,
        delete: del,
        deleteRelation,
        merge,
      }
    }),
  )
}
