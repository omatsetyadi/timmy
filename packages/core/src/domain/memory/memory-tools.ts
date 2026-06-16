import { Context, Effect } from 'effect'
import type { Tool, ToolResult } from 'timmy-sdk'
import { EntityStore } from './entity-store'
import type { RecallImpl } from './recall'

/** The resolved EntityStore service shape (methods return Effects with Db already captured,
 *  so they run with Effect.runPromise directly — no Db context needed at call time). */
export type EntityStoreImpl = Context.Tag.Service<typeof EntityStore>

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''))

const props = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

const fail = (e: unknown): ToolResult => ({ ok: false, error: String(e) })

/** Limits for the EXPLICIT memory query tools (the agent asked → generous view). These are
 *  deliberately separate from the silent auto-recall budget (recall_limit/recall_budget). */
export interface MemoryToolOpts {
  /** memorySearch default limit when the call omits one. */
  searchLimit: number
  /** memoryList hard cap — past this, output is explicitly truncated (never silently dropped). */
  listCap: number
}

const DEFAULT_MEMORY_TOOL_OPTS: MemoryToolOpts = { searchLimit: 25, listCap: 200 }

/** Frontdesk-callable memory tools — let the user query/update/merge the memory graph
 *  conversationally. Standalone factory; registration into the tool registry is a later
 *  wiring task. `store`/`recall` are the already-resolved service impls (Db captured).
 *  `opts` loosens the EXPLICIT query tools (memorySearch/memoryList) — distinct from the
 *  silent auto-recall budget, which stays focused. */
export function buildMemoryTools(
  store: EntityStoreImpl,
  recall: RecallImpl,
  opts: MemoryToolOpts = DEFAULT_MEMORY_TOOL_OPTS,
): Tool[] {
  const memorySearch: Tool = {
    name: 'memorySearch',
    description:
      "Search the user's memory graph for entities related to a query (broad explicit search).",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
    riskLevel: 'safe',
    execute: async (args): Promise<ToolResult> => {
      try {
        const limit = typeof args.limit === 'number' ? args.limit : opts.searchLimit
        const matches = await Effect.runPromise(recall.search(str(args.query), limit))
        return {
          ok: true,
          data: {
            entities: matches.map((e) => ({
              id: e.id,
              kind: e.kind,
              name: e.name,
              properties: e.properties,
            })),
            count: matches.length,
          },
        }
      } catch (e) {
        return fail(e)
      }
    },
  }

  const memoryList: Tool = {
    name: 'memoryList',
    description:
      "List the user's stored memory entities (optionally filtered by kind) — use to survey everything Timmy knows.",
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string' } },
    },
    riskLevel: 'safe',
    execute: async (args): Promise<ToolResult> => {
      try {
        const kind =
          typeof args.kind === 'string' && args.kind.trim() !== '' ? args.kind : undefined
        const all = await Effect.runPromise(store.list(kind))
        const truncated = all.length > opts.listCap
        const shown = truncated ? all.slice(0, opts.listCap) : all
        return {
          ok: true,
          data: {
            entities: shown.map((e) => ({ id: e.id, kind: e.kind, name: e.name })),
            total: all.length,
            shown: shown.length,
            truncated,
          },
        }
      } catch (e) {
        return fail(e)
      }
    },
  }

  const memoryGet: Tool = {
    name: 'memoryGet',
    description: 'Get a single memory entity (and its relations) by id or by name.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
    riskLevel: 'safe',
    execute: async (args): Promise<ToolResult> => {
      try {
        let id = typeof args.id === 'string' ? args.id : ''
        if (!id && typeof args.name === 'string') {
          const all = await Effect.runPromise(store.list())
          const match = all.find((e) => e.name === args.name)
          if (!match) return { ok: false, error: 'not found' }
          id = match.id
        }
        if (!id) return { ok: false, error: 'memoryGet: id or name is required' }
        const result = await Effect.runPromise(store.getEntity(id))
        if (!result) return { ok: false, error: 'not found' }
        return { ok: true, data: result }
      } catch (e) {
        return fail(e)
      }
    },
  }

  const memoryAdd: Tool = {
    name: 'memoryAdd',
    description: 'Add (or upsert) an entity into the memory graph.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        name: { type: 'string' },
        properties: { type: 'object' },
      },
      required: ['kind', 'name'],
    },
    riskLevel: 'confirm',
    execute: async (args): Promise<ToolResult> => {
      try {
        const entity = await Effect.runPromise(
          store.upsert({
            kind: str(args.kind),
            name: str(args.name),
            properties: props(args.properties),
          }),
        )
        return { ok: true, data: entity }
      } catch (e) {
        return fail(e)
      }
    },
  }

  const memoryUpdate: Tool = {
    name: 'memoryUpdate',
    description: "Update an existing entity's properties by id.",
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, properties: { type: 'object' } },
      required: ['id', 'properties'],
    },
    riskLevel: 'confirm',
    execute: async (args): Promise<ToolResult> => {
      try {
        await Effect.runPromise(store.update(str(args.id), props(args.properties)))
        return { ok: true }
      } catch (e) {
        return fail(e)
      }
    },
  }

  const memoryMerge: Tool = {
    name: 'memoryMerge',
    description: 'Merge two entities (B into A) in the memory graph.',
    parameters: {
      type: 'object',
      properties: { idA: { type: 'string' }, idB: { type: 'string' } },
      required: ['idA', 'idB'],
    },
    riskLevel: 'confirm',
    execute: async (args): Promise<ToolResult> => {
      try {
        const merged = await Effect.runPromise(store.merge(str(args.idA), str(args.idB)))
        if (!merged) return { ok: false, error: 'one or both not found' }
        return { ok: true, data: merged }
      } catch (e) {
        return fail(e)
      }
    },
  }

  const memoryRelate: Tool = {
    name: 'memoryRelate',
    description: 'Create a relation (edge) between two entities in the memory graph.',
    parameters: {
      type: 'object',
      properties: {
        fromId: { type: 'string' },
        relation: { type: 'string' },
        toId: { type: 'string' },
        properties: { type: 'object' },
      },
      required: ['fromId', 'relation', 'toId'],
    },
    riskLevel: 'confirm',
    execute: async (args): Promise<ToolResult> => {
      try {
        const relation = await Effect.runPromise(
          store.addRelation(
            str(args.fromId),
            str(args.relation),
            str(args.toId),
            props(args.properties),
          ),
        )
        return { ok: true, data: relation }
      } catch (e) {
        return fail(e)
      }
    },
  }

  const memoryDelete: Tool = {
    name: 'memoryDelete',
    description:
      'Delete a memory entity by id (its relations are removed too). Use to remove a wrong or duplicate entity.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    riskLevel: 'confirm',
    execute: async (args): Promise<ToolResult> => {
      try {
        await Effect.runPromise(store.delete(String(args.id)))
        return { ok: true }
      } catch (e) {
        return fail(e)
      }
    },
  }

  const memoryDeleteRelation: Tool = {
    name: 'memoryDeleteRelation',
    description:
      'Delete a single memory relation (edge) by id, without removing its entities. Use to remove an incorrect relationship.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    riskLevel: 'confirm',
    execute: async (args): Promise<ToolResult> => {
      try {
        await Effect.runPromise(store.deleteRelation(String(args.id)))
        return { ok: true }
      } catch (e) {
        return fail(e)
      }
    },
  }

  return [
    memorySearch,
    memoryList,
    memoryGet,
    memoryAdd,
    memoryUpdate,
    memoryMerge,
    memoryRelate,
    memoryDelete,
    memoryDeleteRelation,
  ]
}
