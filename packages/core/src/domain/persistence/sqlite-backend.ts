/**
 * Runtime-selected SQLite backend — the ONLY place that touches a concrete SQLite driver.
 *
 * - **Bun** (the shipped single binary): `bun:sqlite` — built into the runtime.
 * - **Node** (tests/dev): `node:sqlite` — built into Node ≥ 22.
 *
 * Both are built-in, so neither path needs a native `.node` addon (the reason we dropped
 * better-sqlite3 — it can't load inside a Bun-compiled binary). The two drivers share a
 * better-sqlite3-shaped API (`prepare().run/get/all`, `exec`), so the differences (constructor name,
 * reading PRAGMA user_version, null-vs-undefined) are normalized here and nowhere else.
 */

/** A prepared statement's surface — both drivers expose exactly this. */
interface RawStmt {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
interface RawDb {
  exec(sql: string): void
  prepare(sql: string): RawStmt
}

/** The normalized backend the {@link Db} service drives. Params are passed as an array (spread into
 *  the driver), results are plain rows, and `get` returns `undefined` (never `null`) when empty. */
export interface SqliteDb {
  exec(sql: string): void
  run(sql: string, params: readonly unknown[]): void
  get<T>(sql: string, params: readonly unknown[]): T | undefined
  all<T>(sql: string, params: readonly unknown[]): T[]
  userVersion(): number
  setUserVersion(version: number): void
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

/** Wrap a raw driver handle (already opened + pragmas applied) in the normalized {@link SqliteDb}. */
const wrapRaw = (db: RawDb): SqliteDb => ({
  exec: (sql) => db.exec(sql),
  run: (sql, params) => void db.prepare(sql).run(...params),
  get: <T>(sql: string, params: readonly unknown[]) =>
    (db.prepare(sql).get(...params) ?? undefined) as T | undefined,
  all: <T>(sql: string, params: readonly unknown[]) => db.prepare(sql).all(...params) as T[],
  userVersion: () =>
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
  setUserVersion: (version) => db.exec(`PRAGMA user_version = ${version}`),
})

/** Open + apply the standard pragmas (WAL, foreign keys ON — declared CASCADEs only fire with FKs on). */
const applyPragmas = (db: RawDb): RawDb => {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

export function openSqlite(path: string): SqliteDb {
  // require() (not import) on purpose: the driver is chosen at RUNTIME and must load synchronously
  // (the Db Layer is sync). A static import would make the bundler resolve BOTH drivers, and each only
  // exists in its own runtime (`bun:sqlite` under Bun, `node:sqlite` under Node). The unused branch's
  // require() is never reached, so the absent module is never resolved.
  if (isBun) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite') as { Database: new (p: string) => RawDb }
    return wrapRaw(applyPragmas(new Database(path)))
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => RawDb }
  return wrapRaw(applyPragmas(new DatabaseSync(path)))
}
