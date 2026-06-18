import { Context, Effect, Exit, Layer } from 'effect'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SqlError } from './errors'
import { MIGRATIONS, pendingMigrations } from './migrations'
import { openSqlite } from './sqlite-backend'

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
        // openSqlite picks bun:sqlite (binary) / node:sqlite (Node) and applies WAL + foreign_keys ON
        // (declared ON DELETE CASCADE only fires with FKs on; affects new writes — safe on existing data).
        const db = openSqlite(path)
        // Each migration runs in its own transaction so a failure can't leave a half-applied schema.
        for (const m of pendingMigrations(db.userVersion(), MIGRATIONS)) {
          db.exec('BEGIN')
          try {
            db.exec(m.sql)
            db.setUserVersion(m.version)
            db.exec('COMMIT')
          } catch (e) {
            db.exec('ROLLBACK')
            throw e
          }
        }
        const wrap = <T>(f: () => T) =>
          Effect.try({ try: f, catch: (e) => new SqlError({ message: 'sql failed', cause: e }) })
        const exec = (sql: string) => wrap(() => db.exec(sql))
        return {
          run: (sql, params) => wrap(() => db.run(sql, params)),
          query: <T>(sql: string, params: unknown[]) => wrap(() => db.all<T>(sql, params)),
          get: <T>(sql: string, params: unknown[]) => wrap(() => db.get<T>(sql, params)),
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
