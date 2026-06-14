import { Data } from 'effect'
import type { SqlError } from '../persistence/errors'

export class ChatValidationError extends Data.TaggedError('timmy/chat/ChatValidationError')<{
  readonly message: string
  readonly field?: string
}> {}

export type ChatError = ChatValidationError | SqlError
