import { Context, Effect, Layer } from 'effect'
import { randomUUID } from 'node:crypto'
import { Db } from './db'
import type { SqlError } from './errors'

export interface ThreadRow {
  id: string
  title: string | null
  created_at: string
  updated_at: string
}
export interface MessageRow {
  id: string
  thread_id: string
  role: string
  content: string
  created_at: string
}

export class ThreadStore extends Context.Tag('timmy/persistence/thread-store')<
  ThreadStore,
  {
    readonly createThread: (title?: string | null) => Effect.Effect<string, SqlError>
    readonly threadExists: (id: string) => Effect.Effect<boolean, SqlError>
    readonly addMessage: (
      threadId: string,
      role: string,
      content: string,
    ) => Effect.Effect<void, SqlError>
    readonly getMessages: (threadId: string) => Effect.Effect<MessageRow[], SqlError>
    readonly listThreads: () => Effect.Effect<ThreadRow[], SqlError>
    readonly getThread: (
      id: string,
    ) => Effect.Effect<{ thread: ThreadRow; messages: MessageRow[] } | null, SqlError>
  }
>() {
  static Live = Layer.effect(
    ThreadStore,
    Effect.gen(function* () {
      const db = yield* Db
      const now = () => new Date().toISOString()
      const createThread = (title: string | null = null) =>
        Effect.gen(function* () {
          const id = randomUUID()
          const t = now()
          yield* db.run('INSERT INTO threads (id,title,created_at,updated_at) VALUES (?,?,?,?)', [
            id,
            title,
            t,
            t,
          ])
          return id
        })
      const threadExists = (id: string) =>
        db
          .get<{ one: number }>('SELECT 1 AS one FROM threads WHERE id = ?', [id])
          .pipe(Effect.map((r) => r !== undefined))
      const addMessage = (threadId: string, role: string, content: string) =>
        Effect.gen(function* () {
          const t = now()
          yield* db.run(
            'INSERT INTO messages (id,thread_id,role,content,created_at) VALUES (?,?,?,?,?)',
            [randomUUID(), threadId, role, content, t],
          )
          yield* db.run('UPDATE threads SET updated_at = ? WHERE id = ?', [t, threadId])
        })
      const getMessages = (threadId: string) =>
        db.query<MessageRow>('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC', [
          threadId,
        ])
      const listThreads = () =>
        db.query<ThreadRow>('SELECT * FROM threads ORDER BY updated_at DESC', [])
      const getThread = (id: string) =>
        Effect.gen(function* () {
          const thread = yield* db.get<ThreadRow>('SELECT * FROM threads WHERE id = ?', [id])
          if (!thread) return null
          const messages = yield* getMessages(id)
          return { thread, messages }
        })
      return { createThread, threadExists, addMessage, getMessages, listThreads, getThread }
    }),
  )
}
