import { Effect } from 'effect'
import { load, dump } from 'js-yaml'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { CONFIG_PATH, readConfigSync } from '../domain/config/config'
import { EntityStore } from '../domain/memory/entity-store'
import { Embedder } from '../domain/memory/embedder'
import { buildRuntime } from './runtime'

// ── pure helpers (unit-tested) ───────────────────────────────────────────────

/** `['k=v','a=b c']` → `{ k: 'v', a: 'b c' }`. Split on the FIRST `=`; ignore tokens without `=`. */
export function parseProps(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs) {
    const i = p.indexOf('=')
    if (i < 0) continue
    out[p.slice(0, i)] = p.slice(i + 1)
  }
  return out
}

/** One-line render: `kind  name  {props}  ·  id`. */
export function formatEntity(e: {
  id: string
  kind: string
  name: string
  properties: Record<string, unknown>
}): string {
  const props = Object.entries(e.properties)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ')
  return `${e.kind}  ${e.name}  {${props}}  ·  ${e.id}`
}

// ── flag parsing ─────────────────────────────────────────────────────────────

/** Read the single value following `--<flag>` (e.g. `--kind person`). */
const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

/** Collect every value following a repeatable `--<flag>` (e.g. `--prop k=v --prop a=b`). */
const flagValues = (args: readonly string[], flag: string): string[] => {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1]!)
  }
  return out
}

// ── learning mode config (mirrors model-cli / permission-cli yaml IO) ─────────

type Raw = Record<string, unknown>
const loadRaw = (): Raw => {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    const v = load(readFileSync(CONFIG_PATH, 'utf8'))
    return v && typeof v === 'object' ? (v as Raw) : {}
  } catch {
    return {}
  }
}
const saveRaw = (raw: Raw): void => writeFileSync(CONFIG_PATH, dump(raw), 'utf8')

/** Set `memory.learning_mode` in config.yaml, preserving the rest of the memory block. */
export const setLearningMode = (on: boolean): void => {
  const raw = loadRaw()
  const memory = (raw.memory as Record<string, unknown> | undefined) ?? {}
  raw.memory = { ...memory, learning_mode: on }
  saveRaw(raw)
}

// ── command ──────────────────────────────────────────────────────────────────

/** `timmy memory <list|show|add|update|delete|learning>` — manage the knowledge graph. */
export async function memory(args: readonly string[]): Promise<void> {
  const sub = args[0]

  // `learning` reads/writes config only — no runtime/DB needed.
  if (sub === 'learning') {
    const v = args[1]
    if (v === 'status') {
      console.log(`learning mode: ${readConfigSync().memory.learning_mode ? 'on' : 'off'}`)
    } else if (v === 'on' || v === 'off') {
      setLearningMode(v === 'on')
      console.log(`learning mode → ${v}   (restart Timmy to apply)`)
    } else {
      console.error('Usage: timmy memory learning <on|off|status>')
      process.exit(1)
    }
    return
  }

  const { runtime } = buildRuntime()
  try {
    if (sub === 'list') {
      const kind = flagValue(args, '--kind')
      const entities = await runtime.runPromise(
        EntityStore.pipe(Effect.flatMap((s) => s.list(kind))),
      )
      if (entities.length === 0) console.log('no entities')
      else for (const e of entities) console.log(formatEntity(e))
    } else if (sub === 'show') {
      const id = args[1]
      if (!id) {
        console.error('Usage: timmy memory show <id>')
        process.exit(1)
      }
      const found = await runtime.runPromise(
        EntityStore.pipe(Effect.flatMap((s) => s.getEntity(id))),
      )
      if (!found) {
        console.log('not found')
      } else {
        console.log(formatEntity(found.entity))
        if (found.relations.length) {
          console.log('relations:')
          for (const r of found.relations) console.log(`  ${r.from} -[${r.relation}]-> ${r.to}`)
        }
      }
    } else if (sub === 'add') {
      const kind = flagValue(args, '--kind')
      const name = flagValue(args, '--name')
      if (!kind || !name) {
        console.error('Usage: timmy memory add --kind <k> --name <n> [--prop k=v ...]')
        process.exit(1)
      }
      const properties = parseProps(flagValues(args, '--prop'))
      const entity = await runtime.runPromise(
        EntityStore.pipe(
          Effect.flatMap((s) => s.upsert({ kind, name, properties, source: 'manual' })),
        ),
      )
      console.log(formatEntity(entity))
    } else if (sub === 'update') {
      const id = args[1]
      if (!id) {
        console.error('Usage: timmy memory update <id> --prop k=v ...')
        process.exit(1)
      }
      const properties = parseProps(flagValues(args, '--prop'))
      await runtime.runPromise(EntityStore.pipe(Effect.flatMap((s) => s.update(id, properties))))
      console.log('updated')
    } else if (sub === 'delete') {
      const id = args[1]
      if (!id) {
        console.error('Usage: timmy memory delete <id>')
        process.exit(1)
      }
      await runtime.runPromise(EntityStore.pipe(Effect.flatMap((s) => s.delete(id))))
      console.log('deleted')
    } else if (sub === 'reindex') {
      // Embed every entity that lacks a vector — one-time backfill, or after changing the embed
      // model. The first call downloads + loads the model (slow once), then it's a few ms each.
      console.log('reindexing… (first run downloads the embedding model — one-time)')
      const r = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* EntityStore
          const embedder = yield* Embedder
          const all = yield* store.list()
          let done = 0
          let skipped = 0
          let failed = 0
          for (const e of all) {
            if (e.embedding) {
              skipped++
              continue
            }
            const vec = yield* embedder.embed(`${e.name} ${JSON.stringify(e.properties)}`)
            if (vec) {
              yield* store.setEmbedding(e.id, vec)
              done++
              if (done % 20 === 0) console.log(`  …${done} embedded`)
            } else {
              failed++
            }
          }
          return { total: all.length, done, skipped, failed }
        }),
      )
      console.log(
        `reindex done: ${r.done} embedded, ${r.skipped} already had vectors, ${r.failed} failed (of ${r.total}).` +
          (r.failed > 0 ? '\n(failures usually mean the embed model is unavailable.)' : ''),
      )
    } else {
      console.error(
        'Usage: timmy memory <list [--kind <k>] | show <id> | add --kind <k> --name <n> [--prop k=v ...] | update <id> --prop k=v ... | delete <id> | reindex | learning <on|off|status>>',
      )
      process.exit(1)
    }
  } finally {
    await runtime.dispose()
  }
}
