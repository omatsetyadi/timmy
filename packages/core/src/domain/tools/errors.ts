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

// Defined for callers that choose to fail on bad plugins (Task 4+); the PluginLoader
// itself logs-and-skips for resilience and does not emit this.
export class PluginValidationError extends Data.TaggedError('timmy/tools/PluginValidationError')<{
  readonly message: string
  readonly plugin: string
}> {}

export type ToolDomainError =
  | ToolError
  | ToolNotFoundError
  | MaxIterationsError
  | PluginValidationError
