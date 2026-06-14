import Fastify, { type FastifyInstance } from 'fastify'
import { Server as SocketIOServer } from 'socket.io'
import type { CredentialStore, DetectedCapabilities, ModelProvider } from 'timmy-sdk'
import type { TimmyConfig } from './config'
import { addMessage, createThread, getMessages, getThread, listThreads, threadExists } from './db'
import { buildMessages } from './prompt'

/** Keychain account holding the server's bearer token. */
const AUTH_TOKEN_KEY = 'server:auth_token'

/** Routes reachable without a bearer token (liveness checks). */
const PUBLIC_ROUTES = new Set(['/health'])

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export interface BuildServerDeps {
  config: TimmyConfig
  credentials: CredentialStore
  provider: ModelProvider
  capabilities: DetectedCapabilities
}

/**
 * Build the timmy-core HTTP + WebSocket server. Caller calls `.listen()`.
 * Assumes the DB is already initialized (initDb).
 */
export async function buildServer({
  config,
  credentials,
  provider,
  capabilities,
}: BuildServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: true })

  await registerAuth(app, config, credentials)

  app.get('/health', async () => ({ ok: true }))

  app.get('/models/capabilities', async () => ({
    provider: config.models.frontdesk.provider,
    model: config.models.frontdesk.model,
    capabilities,
  }))

  app.get('/threads', async () => ({ threads: listThreads() }))

  app.get('/threads/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const found = getThread(id)
    if (!found) return reply.code(404).send({ error: 'thread not found' })
    return found
  })

  // Streaming chat: newline-delimited JSON. First line {thread_id}, then
  // {delta} lines as tokens arrive, final {done:true}.
  app.post('/chat', async (req, reply) => {
    const body = (req.body ?? {}) as { message?: string; thread_id?: string }
    if (!body.message || typeof body.message !== 'string') {
      return reply.code(400).send({ error: 'message (string) is required' })
    }

    const threadId =
      body.thread_id && threadExists(body.thread_id) ? body.thread_id : createThread()
    const history = getMessages(threadId)
    const messages = buildMessages(config, history, body.message)
    addMessage(threadId, 'user', body.message)

    reply.hijack()
    reply.raw.statusCode = 200
    reply.raw.setHeader('content-type', 'application/x-ndjson')
    reply.raw.setHeader('x-thread-id', threadId)
    reply.raw.write(JSON.stringify({ thread_id: threadId }) + '\n')

    let full = ''
    try {
      for await (const delta of provider.chat(messages)) {
        full += delta
        reply.raw.write(JSON.stringify({ delta }) + '\n')
      }
      addMessage(threadId, 'assistant', full)
      reply.raw.write(JSON.stringify({ done: true }) + '\n')
      reply.raw.end()
    } catch (err) {
      app.log.error({ err }, 'chat stream failed')
      reply.raw.write(JSON.stringify({ error: (err as Error).message }) + '\n')
      reply.raw.end()
    }
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
  credentials: CredentialStore,
): Promise<void> {
  if (!config.server.auth.enabled) return

  const expected =
    config.server.auth.token === 'keychain'
      ? await credentials.get(AUTH_TOKEN_KEY)
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
