import { Data } from 'effect'

export class ConfigParseError extends Data.TaggedError('timmy/config/ConfigParseError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
