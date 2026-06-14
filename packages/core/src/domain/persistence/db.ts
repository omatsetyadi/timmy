import Database from 'better-sqlite3'
import { Context, Effect, Layer } from 'effect'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SqlError } from './errors'

export class Db extends Context.Tag('timmy/persistence/db')<
  Db,
  {
    readonly run: (sql: string, params: unknown[]) => Effect.Effect<void, SqlError>
    readonly query: <T>(sql: string, params: unknown[]) => Effect.Effect<T[], SqlError>
    readonly get: <T>(sql: string, params: unknown[]) => Effect.Effect<T | undefined, SqlError>
  }
>() {
  static Live = (path: string) =>
    Layer.effect(
      Db,
      Effect.sync(() => {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
        const db = new Database(path)
        db.pragma('journal_mode = WAL')
        // INTERIM schema bootstrap (idempotent CREATE IF NOT EXISTS). This is NOT a
        // migration system — it cannot evolve an existing table (add/alter columns).
        // Replace with a proper versioned migration runner (schema_version + ordered
        // steps) in Phase 5, when the schema first changes (entities/entity_relations).
        db.exec(`
          CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
            content TEXT NOT NULL, created_at TEXT NOT NULL,
            FOREIGN KEY (thread_id) REFERENCES threads(id)
          );
          CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
        `)
        const wrap = <T>(f: () => T) =>
          Effect.try({ try: f, catch: (e) => new SqlError({ message: 'sql failed', cause: e }) })
        return {
          run: (sql, params) => wrap(() => void db.prepare(sql).run(...params)),
          query: <T>(sql: string, params: unknown[]) =>
            wrap(() => db.prepare(sql).all(...params) as T[]),
          get: <T>(sql: string, params: unknown[]) =>
            wrap(() => db.prepare(sql).get(...params) as T | undefined),
        }
      }),
    )
}
