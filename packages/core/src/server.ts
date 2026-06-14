import Fastify, { type FastifyInstance } from 'fastify'
import { Server as SocketIOServer } from 'socket.io'
import type { CredentialStore } from 'timmy-sdk'
import type { TimmyConfig } from './config'

/** Keychain account holding the server's bearer token. */
const AUTH_TOKEN_KEY = 'server:auth_token'

/** Routes reachable without a bearer token (liveness checks). */
const PUBLIC_ROUTES = new Set(['/health'])

export interface BuildServerDeps {
  config: TimmyConfig
  credentials: CredentialStore
}

/**
 * Build the timmy-core HTTP + WebSocket server. Caller is responsible for
 * calling `.listen()`. Socket.io is attached to the same underlying server.
 */
export async function buildServer({
  config,
  credentials,
}: BuildServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: true })

  // Bearer auth — applied to every route except the public ones.
  if (config.server.auth.enabled) {
    const expected =
      config.server.auth.token === 'keychain'
        ? await credentials.get(AUTH_TOKEN_KEY)
        : config.server.auth.token

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

  app.get('/health', async () => ({ ok: true }))

  // WebSocket for voice/dashboard streaming (real handlers arrive later).
  const io = new SocketIOServer(app.server, { path: '/stream' })
  io.on('connection', (socket) => {
    app.log.info({ id: socket.id }, 'socket connected')
    socket.on('disconnect', () => app.log.info({ id: socket.id }, 'socket disconnected'))
  })

  return app
}
