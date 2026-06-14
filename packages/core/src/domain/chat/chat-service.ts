import { Context, Effect, Layer, Ref, Stream } from 'effect'
import { Config } from '../config/config'
import { LlmClient } from '../llm/llm-client'
import { ThreadStore } from '../persistence/thread-store'
import type { StreamChunk } from '../llm/stream-chunk'
import type { LlmError } from '../llm/errors'
import { ChatValidationError, type ChatError } from './errors'
import { buildMessages } from './prompt'

export interface SendParams {
  message: string
  threadId?: string
}

export class ChatService extends Context.Tag('timmy/chat/service')<
  ChatService,
  {
    readonly send: (
      p: SendParams,
    ) => Effect.Effect<
      { threadId: string; stream: Stream.Stream<StreamChunk, LlmError> },
      ChatError
    >
  }
>() {
  static Live = Layer.effect(
    ChatService,
    Effect.gen(function* () {
      const config = yield* (yield* Config).get
      const store = yield* ThreadStore
      const llm = yield* LlmClient

      const send = (p: SendParams) =>
        Effect.gen(function* () {
          if (!p.message?.trim())
            return yield* Effect.fail(
              new ChatValidationError({ message: 'message required', field: 'message' }),
            )
          const exists = p.threadId
            ? yield* store.threadExists(p.threadId).pipe(Effect.orElseSucceed(() => false))
            : false
          const threadId = exists && p.threadId ? p.threadId : yield* store.createThread()
          const history = yield* store.getMessages(threadId).pipe(Effect.orElseSucceed(() => []))
          const messages = buildMessages(config, history, p.message)
          yield* store.addMessage(threadId, 'user', p.message)

          const accRef = yield* Ref.make('')
          const stream = llm.chat(messages).pipe(
            Stream.tap((chunk) =>
              chunk.type === 'content' ? Ref.update(accRef, (s) => s + chunk.content) : Effect.void,
            ),
            Stream.ensuring(
              Effect.gen(function* () {
                const full = yield* Ref.get(accRef)
                if (full)
                  yield* store.addMessage(threadId, 'assistant', full).pipe(
                    Effect.tapError((e) =>
                      Effect.logWarning(`failed to persist assistant message: ${String(e)}`),
                    ),
                    Effect.orElseSucceed(() => undefined),
                  )
              }),
            ),
          )
          return { threadId, stream }
        })
      return { send }
    }),
  )
}
