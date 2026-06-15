import { Data } from 'effect'

export class NetworkError extends Data.TaggedError('timmy/llm/NetworkError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class ApiError extends Data.TaggedError('timmy/llm/ApiError')<{
  readonly message: string
  readonly status?: number
  readonly cause?: unknown
}> {}

export class AuthError extends Data.TaggedError('timmy/llm/AuthError')<{
  readonly message: string
  readonly provider?: string
  readonly cause?: unknown
}> {}

export class RateLimitError extends Data.TaggedError('timmy/llm/RateLimitError')<{
  readonly message: string
  readonly resetsAt?: number
  readonly cause?: unknown
}> {}

export class StreamParsingError extends Data.TaggedError('timmy/llm/StreamParsingError')<{
  readonly message: string
  readonly line?: string
  readonly cause?: unknown
}> {}

export type LlmError = NetworkError | ApiError | AuthError | RateLimitError | StreamParsingError
