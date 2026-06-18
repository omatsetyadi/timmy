import Database from 'better-sqlite3'
import { Context, Effect, Exit, Layer } from 'effect'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SqlError } from './errors'
import { MIGRATIONS, pendingMigrations } from './migrations'

export class Db extends Context.Tag('timmy/persistence/db')<
  Db,
  {
    readonly run: (sql: string, params: unknown[]) => Effect.Effect<void, SqlError>
    readonly query: <T>(sql: string, params: unknown[]) => Effect.Effect<T[], SqlError>
    readonly get: <T>(sql: string, params: unknown[]) => Effect.Effect<T | undefined, SqlError>
    /** Run `body` atomically: BEGIN → body → COMMIT, or ROLLBACK if it fails/interrupts. Use for
     *  multi-write operations (e.g. merge) so a partial failure can't corrupt the graph. */
    readonly transaction: <A, E>(body: Effect.Effect<A, E>) => Effect.Effect<A, E | SqlError>
  }
>() {
  static Live = (path: string) =>
    Layer.effect(
      Db,
      Effect.sync(() => {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
        const db = new Database(path)
        db.pragma('journal_mode = WAL')
        // better-sqlite3 defaults foreign_keys OFF; turn it ON so declared ON DELETE CASCADE
        // (e.g. relations → entities) actually fires. Affects new writes only — safe on existing data.
        db.pragma('foreign_keys = ON')
        const current = db.pragma('user_version', { simple: true }) as number
        const runMigration = db.transaction((m: { version: number; sql: string }) => {
          db.exec(m.sql)
          db.pragma(`user_version = ${m.version}`)
        })
        for (const m of pendingMigrations(current, MIGRATIONS)) runMigration(m)
        const wrap = <T>(f: () => T) =>
          Effect.try({ try: f, catch: (e) => new SqlError({ message: 'sql failed', cause: e }) })
        const exec = (sql: string) => wrap(() => void db.exec(sql))
        return {
          run: (sql, params) => wrap(() => void db.prepare(sql).run(...params)),
          query: <T>(sql: string, params: unknown[]) =>
            wrap(() => db.prepare(sql).all(...params) as T[]),
          get: <T>(sql: string, params: unknown[]) =>
            wrap(() => db.prepare(sql).get(...params) as T | undefined),
          transaction: <A, E>(body: Effect.Effect<A, E>): Effect.Effect<A, E | SqlError> =>
            Effect.acquireUseRelease(
              exec('BEGIN'),
              () => body,
              (_, exit) =>
                // COMMIT on success, ROLLBACK on failure/interrupt. A failed COMMIT/ROLLBACK is a
                // defect (the connection is hosed) — surface it loudly rather than swallow.
                Exit.isSuccess(exit)
                  ? exec('COMMIT').pipe(Effect.orDie)
                  : exec('ROLLBACK').pipe(Effect.orDie),
            ),
        }
      }),
    )
}
