import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'
import { Db } from './db'

it.effect('runs and queries against :memory:', () =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db.run('CREATE TABLE t (x INTEGER)', [])
    yield* db.run('INSERT INTO t (x) VALUES (?)', [42])
    const rows = yield* db.query<{ x: number }>('SELECT x FROM t', [])
    expect(rows).toEqual([{ x: 42 }])
  }).pipe(Effect.provide(Db.Live(':memory:'))),
)
