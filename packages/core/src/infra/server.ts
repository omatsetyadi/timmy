import { Cause, Effect, Either, Fiber, ManagedRuntime, Option, Stream } from 'effect'
import Fastify, { type FastifyInstance } from 'fastify'
import { Server as SocketIOServer } from 'socket.io'
import { ChatService } from '../domain/chat/chat-service'
import type { TimmyConfig } from '../domain/config/config'
import { CredentialStore } from '../domain/credentials/credential-store'
import { LlmClient } from '../domain/llm/llm-client'
import { ThreadStore } from '../domain/persistence/thread-store'
import { PendingConfirmations } from '../domain/tools/confirmations'

/** Keychain account holding the server's bearer token. */
const AUTH_TOKEN_KEY = 'server:auth_token'

/** Routes reachable without a bearer token (liveness checks). */
const PUBLIC_ROUTES = new Set(['/health'])

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/** The services the routes resolve from the runtime. */
type AppServices = ChatService | ThreadStore | LlmClient | CredentialStore | PendingConfirmations

/**
 * Build the timmy-core HTTP + WebSocket server. Caller calls `.listen()`.
 * Logic runs on the Effect `runtime`; Fastify/Socket.io stay as edges.
 */
export async function buildServer(
  config: TimmyConfig,
  runtime: ManagedRuntime.ManagedRuntime<AppServices, never>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true })

  await registerAuth(app, config, runtime)

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
    const body = (req.body ?? {}) as { message?: string; thread_id?: string }
    if (!body.message || typeof body.message !== 'string') {
      return reply.code(400).send({ error: 'message (string) is required' })
    }

    const sent = await runtime.runPromise(
      ChatService.pipe(
        Effect.flatMap((c) => c.send({ message: body.message!, threadId: body.thread_id })),
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

    const fiber = runtime.runFork(
      stream.pipe(
        Stream.runForEach((chunk) => Effect.sync(() => safeWrite(JSON.stringify(chunk) + '\n'))),
        // Surface a mid-stream failure (e.g. Ollama drops): log it and emit an
        // error frame to the client before the finalizer writes {done:true}.
        Effect.tapErrorCause((cause) =>
          Effect.sync(() => {
            app.log.error({ cause: Cause.pretty(cause) }, 'chat stream failed')
            const failure = Cause.failureOption(cause)
            const message = Option.match(failure, {
              onNone: () => 'stream failed',
              onSome: (e) => (e instanceof Error ? e.message : String(e)),
            })
            safeWrite(JSON.stringify({ type: 'error', message }) + '\n')
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            safeWrite(JSON.stringify({ done: true }) + '\n')
            if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end()
          }),
        ),
      ),
    )
    req.raw.on('close', () => {
      runtime.runFork(Fiber.interrupt(fiber))
    })
  })

  // Resolve a pending confirm-tier tool request (surfaced mid-/chat as a
  // {type:'confirm_required'} chunk). A protected route — auth applies via the
  // onRequest hook since it is NOT in PUBLIC_ROUTES.
  app.post('/confirm/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { allowed?: boolean }
    const resolved = await runtime.runPromise(
      PendingConfirmations.pipe(Effect.flatMap((p) => p.resolve(id, body.allowed === true))),
    )
    if (!resolved) return reply.code(404).send({ resolved: false })
    return reply.code(200).send({ resolved: true })
  })

  // WebSocket for voice/dashboard streaming (real handlers arrive later).
  const io = new SocketIOServer(app.server, { path: '/stream' })
  io.on('connection', (socket) => {
    app.log.info({ id: socket.id }, 'socket connected')
    socket.on('disconnect', () => app.log.info({ id: socket.id }, 'socket disconnected'))
  })

  return app
}

/**
 * Bearer auth. With a token configured, enforce it on all non-public routes.
 * Without a token: allow on loopback (local dev convenience, logged), but
 * fail closed on a non-loopback host (network exposure must be authenticated).
 */
async function registerAuth(
  app: FastifyInstance,
  config: TimmyConfig,
  runtime: ManagedRuntime.ManagedRuntime<AppServices, never>,
): Promise<void> {
  if (!config.server.auth.enabled) return

  const expected =
    config.server.auth.token === 'keychain'
      ? await runtime.runPromise(CredentialStore.pipe(Effect.flatMap((c) => c.get(AUTH_TOKEN_KEY))))
      : config.server.auth.token
  const loopback = LOOPBACK_HOSTS.has(config.server.host)

  if (!expected && loopback) {
    app.log.warn('auth enabled but no token set — allowing local (loopback) requests without auth')
    return
  }
  if (!expected && !loopback) {
    app.log.error(
      'auth enabled on a non-loopback host but no token is set — refusing all requests until a token is configured',
    )
  }

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]
    if (PUBLIC_ROUTES.has(path)) return
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (!expected || token !== expected) {
      await reply.code(401).send({ error: 'unauthorized' })
    }
  })
}
