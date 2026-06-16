import { describe, it, expect } from 'vitest'
import { MIGRATIONS, pendingMigrations } from './migrations'

describe('pendingMigrations', () => {
  it('returns all migrations when DB is at version 0', () => {
    expect(pendingMigrations(0, MIGRATIONS).map((m) => m.version)).toEqual(
      MIGRATIONS.map((m) => m.version),
    )
  })
  it('returns only newer migrations', () => {
    const all = [
      { version: 1, sql: 'a' },
      { version: 2, sql: 'b' },
      { version: 3, sql: 'c' },
    ]
    expect(pendingMigrations(2, all)).toEqual([{ version: 3, sql: 'c' }])
  })
  it('returns none when up to date', () => {
    expect(pendingMigrations(99, MIGRATIONS)).toEqual([])
  })
  it('MIGRATIONS are contiguous from 1 and ordered', () => {
    MIGRATIONS.forEach((m, i) => expect(m.version).toBe(i + 1))
  })
})
