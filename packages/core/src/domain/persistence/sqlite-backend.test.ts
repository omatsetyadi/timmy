import { describe, expect, it } from 'vitest'
import { openSqlite } from './sqlite-backend'

describe('openSqlite backend (node:sqlite under Node, bun:sqlite under Bun)', () => {
  it('execs DDL, runs inserts, and reads via get/all with positional params', () => {
    const db = openSqlite(':memory:')
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)')
    db.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1])
    db.run('INSERT INTO t (id, n) VALUES (?, ?)', ['b', 2])
    expect(db.get<{ n: number }>('SELECT n FROM t WHERE id = ?', ['a'])).toEqual({ n: 1 })
    expect(db.all<{ id: string }>('SELECT id FROM t ORDER BY id', [])).toEqual([
      { id: 'a' },
      { id: 'b' },
    ])
  })

  it('returns undefined (not null) when get matches no row', () => {
    const db = openSqlite(':memory:')
    db.exec('CREATE TABLE t (id TEXT)')
    expect(db.get('SELECT id FROM t WHERE id = ?', ['nope'])).toBeUndefined()
  })

  it('round-trips a BLOB (embedding bytes) intact', () => {
    const db = openSqlite(':memory:')
    db.exec('CREATE TABLE v (id TEXT, e BLOB)')
    const bytes = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer)
    db.run('INSERT INTO v (id, e) VALUES (?, ?)', ['x', bytes])
    const row = db.get<{ e: Uint8Array }>('SELECT e FROM v WHERE id = ?', ['x'])
    const out = new Float32Array(
      row!.e.buffer.slice(row!.e.byteOffset, row!.e.byteOffset + row!.e.byteLength),
    )
    expect(Array.from(out)[0]).toBeCloseTo(0.1, 5)
    expect(Array.from(out)).toHaveLength(3)
  })

  it('reads and writes PRAGMA user_version', () => {
    const db = openSqlite(':memory:')
    expect(db.userVersion()).toBe(0)
    db.setUserVersion(3)
    expect(db.userVersion()).toBe(3)
  })
})
