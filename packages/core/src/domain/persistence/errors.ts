import { Data } from 'effect'

export class SqlError extends Data.TaggedError('timmy/persistence/SqlError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class ThreadNotFoundError extends Data.TaggedError('timmy/persistence/ThreadNotFoundError')<{
  readonly message: string
  readonly threadId: string
}> {}

export type PersistenceError = SqlError | ThreadNotFoundError
