import { Data } from 'effect'

export class ChatValidationError extends Data.TaggedError('timmy/chat/ChatValidationError')<{
  readonly message: string
  readonly field?: string
}> {}

export type ChatError = ChatValidationError
