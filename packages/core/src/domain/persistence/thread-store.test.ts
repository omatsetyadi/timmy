import { it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { expect } from 'vitest'
import { Db } from './db'
import { ThreadStore } from './thread-store'

const TestLayer = ThreadStore.Live.pipe(Layer.provide(Db.Live(':memory:')))

it.effect('creates a thread, appends messages, reads them back in order', () =>
  Effect.gen(function* () {
    const store = yield* ThreadStore
    const id = yield* store.createThread()
    yield* store.addMessage(id, 'user', 'hello')
    yield* store.addMessage(id, 'assistant', 'hi')
    const msgs = yield* store.getMessages(id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(yield* store.threadExists(id)).toBe(true)
  }).pipe(Effect.provide(TestLayer)),
)
