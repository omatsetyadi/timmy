import { Cause, Effect, Either, Fiber, ManagedRuntime, Option, Stream } from 'effect'
import Fastify, { type FastifyInstance } from 'fastify'
import { Server as SocketIOServer } from 'socket.io'
import { ChatService } from '../domain/chat/chat-service'
import { Config, type TimmyConfig } from '../domain/config/config'
import { CredentialStore } from '../domain/credentials/credential-store'
import { LlmClient } from '../domain/llm/llm-client'
import { ProviderRegistry } from '../domain/llm/provider-registry'
import type { StreamChunk } from '../domain/llm/stream-chunk'
import { ThreadStore } from '../domain/persistence/thread-store'
import { EntityStore } from '../domain/memory/entity-store'
import { PendingConfirmations } from '../domain/tools/confirmations'
import { mergeOverlay, PermissionOverlay } from '../domain/tools/permission-overlay'
import { statusReport } from './model-cli'
import { addAllowedCommand, setMode, setOverride } from './permission-cli'

/** Keychain account holding the server's bearer token. */
const AUTH_TOKEN_KEY = 'server:auth_token'

/** Routes reachable without a bearer token (liveness checks). */
const PUBLIC_ROUTES = new Set(['/health'])

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/** The services the routes resolve from the runtime. */
type AppServices =
  | ChatService
  | ThreadStore
  | LlmClient
  | CredentialStore
  | PendingConfirmations
  | PermissionOverlay
  | Config
  | ProviderRegistry
  | EntityStore

/**
 * Build the timmy-core HTTP + WebSocket server. Caller calls `.listen()`.
 * Logic runs on the Effect `runtime`; Fastify/Socket.io stay as edges.
 */
export async function buildServer(
  config: TimmyConfig,
  runtime: ManagedRuntime.ManagedRuntime<AppServices, never>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true })

  const authorize = await registerAuth(app, config, runtime)

  app.get('/health', async () => ({ ok: true }))

  app.get('/models/capabilities', async () => {
    const capabilities = await runtime.runPromise(
      LlmClient.pipe(Effect.flatMap((c) => c.detectCapabilities())),
    )
    return {
      provider: config.models.frontdesk.provider,
      model: config.models.frontdesk.model,
      capabilities,
    }
  })

  app.get('/models/status', async () => runtime.runPromise(statusReport))

  app.get('/threads', async () => {
    const threads = await runtime.runPromise(
      ThreadStore.pipe(Effect.flatMap((s) => s.listThreads())),
    )
    return { threads }
  })

  app.get('/threads/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const found = await runtime.runPromise(ThreadStore.pipe(Effect.flatMap((s) => s.getThread(id))))
    if (!found) return reply.code(404).send({ error: 'thread not found' })
    return found
  })

  // Streaming chat: newline-delimited JSON. First line {thread_id}, then typed
  // chunk lines as tokens arrive, final {done:true}.
  app.post('/chat', async (req, reply) => {
    const body = (req.body ?? {}) as { message?: string; thread_id?: string; channel?: 'voice' }
    if (!body.message || typeof body.message !== 'string') {
      return reply.code(400).send({ error: 'message (string) is required' })
    }

    const sent = await runtime.runPromise(
      ChatService.pipe(
        Effect.flatMap((c) =>
          c.send({
            message: body.message!,
            threadId: body.thread_id,
            channel: body.channel === 'voice' ? 'voice' : 'text',
          }),
        ),
        Effect.either,
      ),
    )
    if (Either.isLeft(sent)) {
      // Map domain failures by _tag at the edge: validation → 400, else 500.
      const err = sent.left
      const status = err._tag === 'timmy/chat/ChatValidationError' ? 400 : 500
      return reply.code(status).send({ error: err.message })
    }

    const { threadId, stream } = sent.right
    reply.hijack()
    // A late socket error (e.g. client disconnect) must not become an uncaught
    // exception once we've hijacked the raw socket.
    reply.raw.on('error', () => {})
    reply.raw.statusCode = 200
    reply.raw.setHeader('content-type', 'application/x-ndjson')
    reply.raw.setHeader('x-thread-id', threadId)
    // Guard every write: on disconnect the socket may already be destroyed.
    const safeWrite = (s: string) => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(s)
    }
    safeWrite(JSON.stringify({ thread_id: threadId }) + '\n')

    // NDJSON sink: each chunk a line, a mid-stream failure as {type:'error'}, {done:true} last.
    const fiber = pumpChat(runtime, app.log, stream, {
      chunk: (chunk) => safeWrite(JSON.stringify(chunk) + '\n'),
      error: (message) => safeWrite(JSON.stringify({ type: 'error', message }) + '\n'),
      done: () => {
        safeWrite(JSON.stringify({ done: true }) + '\n')
        if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end()
      },
    })
    req.raw.on('close', () => {
      runtime.runFork(Fiber.interrupt(fiber))
    })
  })

  // Resolve a pending confirm-tier tool request (surfaced mid-/chat as a
  // {type:'confirm_required'} chunk). A protected route — auth applies via the
  // onRequest hook since it is NOT in PUBLIC_ROUTES.
  app.post('/confirm/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { decision } = (req.body ?? {}) as { decision?: 'once' | 'always' | 'deny' }
    const resolved = await applyConfirmDecision(runtime, id, decision)
    if (!resolved) return reply.code(404).send({ resolved: false })
    return reply.code(200).send({ resolved: true })
  })

  // Live permission posture for the TUI: the boot config merged with the session overlay.
  app.get('/permissions', async () => {
    const [cfg, ov] = await runtime.runPromise(
      Effect.all([
        Config.pipe(Effect.flatMap((c) => c.get)),
        PermissionOverlay.pipe(Effect.flatMap((o) => o.get)),
      ]),
    )
    return mergeOverlay(cfg.permissions, ov)
  })

  // Mutate the posture: set the mode, a tool/plugin override, or add an allowed command.
  // Updates the live overlay AND writes through to config.yaml for persistence.
  app.post('/permissions', async (req, reply) => {
    const body = (req.body ?? {}) as
      | { mode: 'default' | 'yolo' }
      | { kind: 'tool' | 'plugin'; name: string; perm: 'allow' | 'ask' | 'block' }
      | { allowCommand: string }
    if ('mode' in body) {
      await runtime.runPromise(PermissionOverlay.pipe(Effect.flatMap((o) => o.setMode(body.mode))))
      setMode(body.mode)
    } else if ('allowCommand' in body) {
      await runtime.runPromise(
        PermissionOverlay.pipe(Effect.flatMap((o) => o.allowCommand(body.allowCommand))),
      )
      addAllowedCommand(body.allowCommand)
    } else if ('kind' in body) {
      // The overlay tracks tool-keyed overrides only; a kind:'plugin' override still persists to
      // config (effective next boot) but has no live overlay effect — an accepted v1 limitation.
      await runtime.runPromise(
        PermissionOverlay.pipe(Effect.flatMap((o) => o.setOverride(body.name, body.perm))),
      )
      setOverride(body.kind, body.name, body.perm)
    } else {
      return reply.code(400).send({ error: 'unknown permission mutation' })
    }
    return reply.code(200).send({ ok: true })
  })

  // ── Memory (knowledge graph) ──────────────────────────────────────────────
  // Protected by the onRequest auth hook (not in PUBLIC_ROUTES).
  app.get('/memory/entities', async (req) => {
    const { kind } = (req.query ?? {}) as { kind?: string }
    const entities = await runtime.runPromise(EntityStore.pipe(Effect.flatMap((s) => s.list(kind))))
    return { entities }
  })

  app.get('/memory/entities/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const found = await runtime.runPromise(EntityStore.pipe(Effect.flatMap((s) => s.getEntity(id))))
    if (!found) return reply.code(404).send({ error: 'entity not found' })
    return found
  })

  app.post('/memory/entities', async (req, reply) => {
    const body = (req.body ?? {}) as {
      kind?: string
      name?: string
      properties?: Record<string, unknown>
    }
    if (!body.kind || !body.name) {
      return reply.code(400).send({ error: 'kind and name (strings) are required' })
    }
    const entity = await runtime.runPromise(
      EntityStore.pipe(
        Effect.flatMap((s) =>
          s.upsert({
            kind: body.kind!,
            name: body.name!,
            properties: body.properties,
            source: 'manual',
          }),
        ),
      ),
    )
    return reply.code(200).send(entity)
  })

  app.patch('/memory/entities/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { properties?: Record<string, unknown> }
    await runtime.runPromise(
      EntityStore.pipe(Effect.flatMap((s) => s.update(id, body.properties ?? {}))),
    )
    return reply.code(200).send({ ok: true })
  })

  app.delete('/memory/entities/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    await runtime.runPromise(EntityStore.pipe(Effect.flatMap((s) => s.delete(id))))
    return reply.code(200).send({ ok: true })
  })

  // The whole graph (entities + every relation) for the future dashboard viz.
  app.get('/memory/graph', async () => {
    const [entities, relations] = await runtime.runPromise(
      Effect.all([
        EntityStore.pipe(Effect.flatMap((s) => s.list())),
        EntityStore.pipe(Effect.flatMap((s) => s.allRelations())),
      ]),
    )
    return { entities, relations }
  })

  // WebSocket bridge for the voice daemon: mirrors POST /chat + POST /confirm over Socket.IO,
  // emitting the same StreamChunk shapes /chat streams as NDJSON. One active turn per socket;
  // a new `chat` or `interrupt` cancels the in-flight turn (barge-in). See voice spec §3.2.
  const io = new SocketIOServer(app.server, { path: '/stream' })
  // Socket.IO attaches to the raw http server, so Fastify's onRequest auth hook never runs for the
  // WS handshake. Gate it here with the SAME `authorize` predicate so the voice socket can't bypass
  // auth. Clients pass the bearer token via `auth: { token }` (preferred) or an Authorization header.
  io.use((socket, next) => {
    const fromAuth = socket.handshake.auth?.token
    const token =
      typeof fromAuth === 'string' ? fromAuth : bearerToken(socket.handshake.headers.authorization)
    if (authorize(token)) return next()
    next(new Error('unauthorized'))
  })
  io.on('connection', (socket) => {
    app.log.info({ id: socket.id }, 'socket connected')
    let active: Fiber.RuntimeFiber<void, unknown> | null = null
    const interruptActive = () => {
      if (active) {
        runtime.runFork(Fiber.interrupt(active))
        active = null
      }
    }

    socket.on(
      'chat',
      async (body: { message?: string; thread_id?: string; channel?: 'voice' | 'text' }) => {
        if (!body?.message || typeof body.message !== 'string') {
          socket.emit('chunk', { type: 'error', message: 'message (string) is required' })
          socket.emit('done', {})
          return
        }
        // One turn per socket: a new utterance (or barge-in) interrupts the in-flight turn first.
        interruptActive()
        // The voice daemon connects here and tags turns `channel: 'voice'` (defaults to text if absent).
        const sent = await runtime.runPromise(
          ChatService.pipe(
            Effect.flatMap((c) =>
              c.send({
                message: body.message!,
                threadId: body.thread_id,
                channel: body.channel === 'voice' ? 'voice' : 'text',
              }),
            ),
            Effect.either,
          ),
        )
        if (Either.isLeft(sent)) {
          socket.emit('chunk', { type: 'error', message: sent.left.message })
          socket.emit('done', {})
          return
        }
        const { threadId, stream } = sent.right
        socket.emit('thread', { thread_id: threadId })
        let turn: Fiber.RuntimeFiber<void, unknown> | null = null
        turn = pumpChat(runtime, app.log, stream, {
          chunk: (chunk) => socket.emit('chunk', chunk),
          error: (message) => socket.emit('chunk', { type: 'error', message }),
          done: () => {
            // Only clear if THIS turn is still active — guards against a just-interrupted
            // turn's finalizer nulling out a newer turn started by a barge-in.
            if (active === turn) active = null
            socket.emit('done', {})
          },
        })
        active = turn
      },
    )

    socket.on('confirm', (body: { id?: string; decision?: 'once' | 'always' | 'deny' }) => {
      if (!body?.id) return
      void applyConfirmDecision(runtime, body.id, body.decision)
    })

    socket.on('interrupt', () => interruptActive())

    socket.on('disconnect', () => {
      interruptActive()
      app.log.info({ id: socket.id }, 'socket disconnected')
    })
  })

  return app
}

/**
 * Apply a confirm-tier decision: on "always" persist the allowance (live overlay + config.yaml),
 * then resolve the pending request. Shared by HTTP POST /confirm and the WS `confirm` event so the
 * once|always|deny logic lives in one place. Returns whether a pending entry was found + resolved.
 */
async function applyConfirmDecision(
  runtime: ManagedRuntime.ManagedRuntime<AppServices, never>,
  id: string,
  decision: 'once' | 'always' | 'deny' | undefined,
): Promise<boolean> {
  if (decision === 'always') {
    const always = await runtime.runPromise(
      PendingConfirmations.pipe(Effect.flatMap((p) => p.peek(id))),
    )
    if (always) {
      if (always.scope === 'command') {
        await runtime.runPromise(
          PermissionOverlay.pipe(Effect.flatMap((o) => o.allowCommand(always.signature))),
        )
        addAllowedCommand(always.signature)
      } else {
        await runtime.runPromise(
          PermissionOverlay.pipe(Effect.flatMap((o) => o.setOverride(always.tool, 'allow'))),
        )
        setOverride('tool', always.tool, 'allow')
      }
    }
  }
  const allowed = decision === 'always' || decision === 'once'
  return runtime.runPromise(
    PendingConfirmations.pipe(Effect.flatMap((p) => p.resolve(id, allowed))),
  )
}

/** A transport-agnostic sink the chat stream drives: NDJSON writer (HTTP) or socket emitter (WS). */
interface ChatSink {
  readonly chunk: (chunk: StreamChunk) => void
  readonly error: (message: string) => void
  readonly done: () => void
}

/**
 * Run a chat stream into a sink as a detached fiber. A mid-stream failure is logged and surfaced as
 * one `error` frame; the finalizer ALWAYS calls `done` (including on interrupt — this is how a
 * barge-in produces the final `done`). Interrupt the returned fiber to cancel the turn. Shared by
 * HTTP /chat and the WS bridge.
 */
function pumpChat(
  runtime: ManagedRuntime.ManagedRuntime<AppServices, never>,
  log: FastifyInstance['log'],
  stream: Stream.Stream<StreamChunk, unknown>,
  sink: ChatSink,
): Fiber.RuntimeFiber<void, unknown> {
  return runtime.runFork(
    stream.pipe(
      Stream.runForEach((chunk) => Effect.sync(() => sink.chunk(chunk))),
      Effect.tapErrorCause((cause) =>
        Effect.sync(() => {
          log.error({ cause: Cause.pretty(cause) }, 'chat stream failed')
          const failure = Cause.failureOption(cause)
          const message = Option.match(failure, {
            onNone: () => 'stream failed',
            onSome: (e) => (e instanceof Error ? e.message : String(e)),
          })
          sink.error(message)
        }),
      ),
      Effect.ensuring(Effect.sync(() => sink.done())),
    ),
  )
}

/** Extract the bearer token from an Authorization header (`''` if absent/malformed). */
const bearerToken = (header: string | undefined): string => {
  const h = header ?? ''
  return h.startsWith('Bearer ') ? h.slice('Bearer '.length) : ''
}

/** Decides whether a presented token is authorized. Shared by the HTTP hook and the WS handshake. */
type AuthGate = (token: string) => boolean

/**
 * Bearer auth. With a token configured, enforce it on all non-public routes.
 * Without a token: allow on loopback (local dev convenience, logged), but
 * fail closed on a non-loopback host (network exposure must be authenticated).
 *
 * Returns an {@link AuthGate} so the WS handshake (which bypasses Fastify's onRequest hook) enforces
 * the exact same policy.
 */
async function registerAuth(
  app: FastifyInstance,
  config: TimmyConfig,
  runtime: ManagedRuntime.ManagedRuntime<AppServices, never>,
): Promise<AuthGate> {
  if (!config.server.auth.enabled) return () => true

  const expected =
    config.server.auth.token === 'keychain'
      ? await runtime.runPromise(CredentialStore.pipe(Effect.flatMap((c) => c.get(AUTH_TOKEN_KEY))))
      : config.server.auth.token
  const loopback = LOOPBACK_HOSTS.has(config.server.host)

  if (!expected && loopback) {
    app.log.warn('auth enabled but no token set — allowing local (loopback) requests without auth')
  } else if (!expected && !loopback) {
    app.log.error(
      'auth enabled on a non-loopback host but no token is set — refusing all requests until a token is configured',
    )
  }

  // No token: loopback is allowed (dev convenience), a network host fails closed. With a token, it
  // must match exactly.
  const authorize: AuthGate = expected ? (token) => token === expected : () => loopback

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]
    if (PUBLIC_ROUTES.has(path)) return
    if (!authorize(bearerToken(req.headers.authorization))) {
      await reply.code(401).send({ error: 'unauthorized' })
    }
  })
  return authorize
}
