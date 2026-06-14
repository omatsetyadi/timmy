import { Data } from 'effect'

export class ToolError extends Data.TaggedError('timmy/tools/ToolError')<{
  readonly message: string
  readonly tool: string
  readonly cause?: unknown
}> {}

export class ToolNotFoundError extends Data.TaggedError('timmy/tools/ToolNotFoundError')<{
  readonly message: string
  readonly tool: string
}> {}

export class MaxIterationsError extends Data.TaggedError('timmy/tools/MaxIterationsError')<{
  readonly message: string
  readonly limit: number
}> {}

export type ToolDomainError = ToolError | ToolNotFoundError | MaxIterationsError
