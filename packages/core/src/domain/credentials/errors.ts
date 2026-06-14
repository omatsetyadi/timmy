import { Data } from 'effect'

export class KeychainError extends Data.TaggedError('timmy/credentials/KeychainError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
