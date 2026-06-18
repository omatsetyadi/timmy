import { Context, Effect, Fiber, Layer, Ref, Stream } from 'effect'
import { Config, effectiveProviders } from '../config/config'
import { LlmClient, type ChatMessage } from '../llm/llm-client'
import { resolveModelCapabilities } from '../llm/capabilities'
import { KNOWN_BASE_URLS, resolveBaseUrl } from '../llm/known-providers'
import { ThreadStore } from '../persistence/thread-store'
import { ToolRegistry } from '../tools/tool-registry'
import { SafeExecution } from '../tools/safe-execution'
import type { StreamChunk, ToolCallChunk } from '../llm/stream-chunk'
import type { LlmError } from '../llm/errors'
import { ChatValidationError, type ChatError } from './errors'
import { buildMessages, type Channel } from './prompt'
import { extractImagePaths, attachImages } from './image-attach'
import { ProviderRegistry } from '../llm/provider-registry'
import { Recall } from '../memory/recall'
import { Extractor } from '../memory/extract'

export interface SendParams {
  message: string
  threadId?: string
  /** Which channel the turn came from. `voice` appends the spoken-register prompt fragment. */
  channel?: Channel
}

/** Bounded agentic loop: stop after this many tool-result rounds. This is a runaway backstop,
 *  NOT a task budget — each round is one model turn (typically one tool call + verify), so real
 *  multi-step work (e.g. app-control: open → verify → focus → act → confirm) needs headroom.
 *  Sized generously; a genuine task that exceeds this is almost certainly stuck in a loop. */
const MAX_TOOL_ITERATIONS = 25

/** Shown when the model returns a truly empty completion (no text, no tool call) even after one
 *  retry — so the user gets a clear line instead of a confusing blank. */
const EMPTY_COMPLETION_FALLBACK = 'Hmm, I blanked there — mind saying that again?'

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
      const registry = yield* ToolRegistry
      const safeExec = yield* SafeExecution
      const providerRegistry = yield* ProviderRegistry
      const recall = yield* Recall
      const extractor = yield* Extractor

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
          const pool = yield* providerRegistry.pool
          const claudeAvailable = config.providers?.claude_code !== undefined
          // Recall: pull the relevant memory subgraph for this message. `forMessage` is already
          // catchAll-wrapped to a safe empty result, but guard again so a failure here can never
          // break chat. `block` is injected into the system prompt; `entityNames` drives the
          // stream-start `memory_recall` chunk.
          const { block, entityNames } = yield* recall
            .forMessage(p.message)
            .pipe(Effect.orElseSucceed(() => ({ block: '', entityNames: [] as string[] })))
          const messages = buildMessages(
            config,
            history,
            p.message,
            pool.map((t) => t.id),
            claudeAvailable,
            block,
            p.channel ?? 'text',
          )
          yield* store.addMessage(threadId, 'user', p.message)

          // Native-first vision: if the message references an image AND the frontdesk model can
          // see (Ollama tells us truthfully via /api/show), attach the image inline to the
          // frontdesk call — one call, no askVision round-trip. Only the text is persisted
          // above (images are request-only). If the frontdesk can't see, we don't attach and
          // it can fall back to the askVision tool. The capability probe runs ONLY when an
          // image path is present, so there's no per-message overhead otherwise.
          if (extractImagePaths(p.message).length > 0) {
            const fd = config.models.frontdesk
            const pc = effectiveProviders(config)[fd.provider]
            // Mirror frontdeskTarget's precedence: configured kind → known-cloud → ollama.
            const fdKind = pc?.kind ?? (fd.provider in KNOWN_BASE_URLS ? 'openai-compat' : 'ollama')
            const baseUrl = resolveBaseUrl(fd.provider, pc?.base_url ?? fd.base_url)
            // Probe + read can reject (network / fs perms); degrade to "no inline image" rather
            // than letting a defect hang the stream — the frontdesk can still use the askVision tool.
            const caps = yield* Effect.tryPromise(() =>
              resolveModelCapabilities(fdKind, fd.model, baseUrl),
            ).pipe(Effect.orElseSucceed(() => ({ vision: false }) as { vision: boolean }))
            if (caps.vision) {
              const images = yield* Effect.tryPromise(() => attachImages(p.message)).pipe(
                Effect.orElseSucceed(() => [] as string[]),
              )
              const lastUser = messages[messages.length - 1]
              if (images.length > 0 && lastUser) lastUser.images = images
            }
          }

          const tools = registry.toModelTools()

          // Accumulate assistant content for end-of-stream persistence. We update this
          // at the EMIT point inside the loop (not via an outer Stream.tap) so the text
          // is recorded the instant a content chunk is produced — robust against a
          // consumer that gets interrupted before it pulls the buffered chunk (spec §9.5).
          const accRef = yield* Ref.make('')

          // The agentic tool-loop (EFFECT_CONVENTIONS §Streaming, WORKFLOW_ENGINE_REFERENCE
          // §5; matches jitera's workflow-stream-processor). We use Stream.async and run the
          // loop in a DETACHED fiber (Effect.runFork, below) — NOT Stream.asyncEffect with the
          // loop as the driver. asyncEffect couples the loop to the consumer's pull, so a
          // blocking step inside it (the 30s confirm wait — or even a full llm.chat turn)
          // freezes delivery of every already-emitted chunk until it unblocks (proven: an item
          // emitted before a 3s block wasn't delivered until 3007ms). A detached producer +
          // callback `emit` flushes each chunk to the consumer immediately, so tokens stream
          // live AND the mid-stream `confirm_required` reaches the client in time to answer.
          //   - run one llm.chat turn, forwarding every chunk to the consumer
          //   - accumulate tool_call chunks during the turn
          //   - when the turn ends WITH tool_calls: execute each through SafeExecution,
          //     append assistant+tool messages, and loop with the extended history
          //   - stop when a turn has NO tool_calls (normal finish) or the cap is hit
          //     (emit a single {type:'error'} chunk and stop).
          const loopStream: Stream.Stream<StreamChunk, LlmError> = Stream.async<
            StreamChunk,
            LlmError
          >((emit) => {
            // `emit` is callback-based: emit.single(chunk) / emit.end() / emit.fail(err).
            const runIteration = (
              convo: ChatMessage[],
              iteration: number,
              retriedEmpty = false,
            ): Effect.Effect<void, LlmError> =>
              Effect.gen(function* () {
                const collected: ToolCallChunk[] = []
                let producedContent = false
                // Forward this turn's chunks to the consumer as they arrive,
                // accumulating any tool_call chunks for the post-turn execution.
                yield* llm.chat(convo, tools).pipe(
                  Stream.runForEach((chunk) =>
                    Effect.gen(function* () {
                      if (chunk.type === 'tool_call') collected.push(chunk.toolCall)
                      if (chunk.type === 'content') {
                        producedContent = true
                        yield* Ref.update(accRef, (s) => s + chunk.content)
                      }
                      emit.single(chunk)
                    }),
                  ),
                  // A turn-level LLM failure ends the whole stream with that error.
                  Effect.catchAll((e: LlmError) => Effect.sync(() => emit.fail(e))),
                )

                // No tools requested → the model is done. End the stream.
                if (collected.length === 0) {
                  // Empty completion (no text AND no tool call) — weak/cloud frontdesks do this
                  // intermittently. Don't end on a silent blank: retry the same turn ONCE (transient,
                  // usually recovers), then surface a clear line so the user never sees nothing.
                  if (!producedContent && !retriedEmpty) {
                    yield* runIteration(convo, iteration, true)
                    return
                  }
                  if (!producedContent) {
                    yield* Ref.update(accRef, (s) => s + EMPTY_COMPLETION_FALLBACK)
                    yield* Effect.sync(() =>
                      emit.single({ type: 'content', content: EMPTY_COMPLETION_FALLBACK }),
                    )
                  }
                  yield* Effect.sync(() => emit.end())
                  return
                }

                // Cap reached → emit a single error chunk and stop looping.
                if (iteration >= MAX_TOOL_ITERATIONS) {
                  yield* Effect.sync(() => {
                    emit.single({ type: 'error', message: 'max tool iterations reached' })
                    emit.end()
                  })
                  return
                }

                // Feed results back as a PROPER tool round: one assistant message carrying
                // ALL this turn's tool_calls, then one tool-result message per call keyed by
                // its id. Strict cloud APIs (OpenAI/DeepSeek) return 400 on a tool message
                // lacking a matching assistant tool_calls + tool_call_id (Ollama tolerated the
                // old `[tool_call X]` text form; cloud frontdesks do not).
                const next: ChatMessage[] = [
                  ...convo,
                  {
                    role: 'assistant',
                    content: '',
                    tool_calls: collected.map((c) => ({
                      id: c.id,
                      name: c.name,
                      arguments: c.arguments,
                    })),
                  },
                ]
                for (const call of collected) {
                  const args = yield* parseArgs(call.arguments)
                  const tool = registry.list().find((t) => t.name === call.name)
                  const result = tool
                    ? yield* safeExec.run(
                        tool,
                        args,
                        call.id,
                        // Wire emitConfirm onto THIS loop's emitter: when SafeExecution
                        // gates a confirm-tier tool, push a {type:'confirm_required'} chunk
                        // onto the same `emit` that emits content/tool_call. The client sees
                        // it mid-stream, then the tool runs (or is declined) once /confirm
                        // resolves the Deferred SafeExecution is awaiting.
                        (req) =>
                          Effect.sync(() =>
                            emit.single({
                              type: 'confirm_required',
                              id: req.id,
                              tool: req.tool,
                              description: req.description,
                              always: req.always,
                            }),
                          ),
                        () =>
                          registry
                            .execute(call.name, args)
                            .pipe(
                              Effect.catchAll((e) =>
                                Effect.succeed({ ok: false, error: String(e) }),
                              ),
                            ),
                      )
                    : { ok: false, error: `unknown tool ${call.name}` }
                  next.push({
                    role: 'tool',
                    content: JSON.stringify(result),
                    tool_call_id: call.id,
                  })
                }

                // Loop with the extended history.
                yield* runIteration(next, iteration + 1)
              })

            // Stream-start: surface the recalled entities to the client so the UI can show
            // "remembering: …" before any tokens arrive. Emitted once, before the first turn.
            if (entityNames.length > 0) {
              emit.single({ type: 'memory_recall', entities: entityNames })
            }

            // Run the loop in a detached fiber so emitted chunks flush to the consumer
            // immediately, even while the loop blocks awaiting a confirm. Return a finalizer
            // that interrupts the producer when the consumer-facing stream ends or is
            // interrupted (e.g. client disconnect). emit.end()/emit.fail() terminate the stream.
            const fiber = Effect.runFork(runIteration(messages, 0))
            return Fiber.interrupt(fiber)
          }, 'unbounded')

          // Preserve the foundation's persist-on-finish wrapping around the WHOLE loop
          // stream. Stream.ensuring runs on success/failure/interrupt; accRef was filled
          // at the emit point above.
          const stream = loopStream.pipe(
            Stream.ensuring(
              Effect.gen(function* () {
                const full = yield* Ref.get(accRef)
                if (full) {
                  yield* store.addMessage(threadId, 'assistant', full).pipe(
                    Effect.tapError((e) =>
                      Effect.logWarning(`failed to persist assistant message: ${String(e)}`),
                    ),
                    Effect.orElseSucceed(() => undefined),
                  )
                  // Post-turn learning: extract a knowledge graph from this exchange and persist
                  // it. Fired DETACHED (runFork) so it never blocks or affects the stream; the
                  // extractor is already catchAll-wrapped, so a failure is swallowed silently.
                  if (config.memory.learning_mode) {
                    Effect.runFork(extractor.extract(p.message, full))
                  }
                }
              }),
            ),
          )
          return { threadId, stream }
        })
      return { send }
    }),
  )
}

/** Parse tool-call arguments JSON; an unparseable string degrades to `{}` rather than killing the turn. */
const parseArgs = (raw: string): Effect.Effect<Record<string, unknown>> =>
  Effect.try(() => JSON.parse(raw) as Record<string, unknown>).pipe(
    Effect.orElseSucceed(() => ({}) as Record<string, unknown>),
  )
