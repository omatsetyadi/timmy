#!/usr/bin/env node
import { loadConfig } from './config'
import { KeychainCredentialStore } from './credentials'
import { initDb } from './db'
import { createFrontdeskProvider } from './providers'
import { buildServer } from './server'

const VERSION = '0.1.0'

async function start(): Promise<void> {
  const config = loadConfig()
  const credentials = new KeychainCredentialStore()

  initDb()
  const provider = createFrontdeskProvider(config)
  const available = await provider.isAvailable()
  if (!available) {
    console.warn(
      `Frontdesk provider "${config.models.frontdesk.provider}" (${config.models.frontdesk.model}) is not reachable — chat will fail until it's up.`,
    )
  }
  const capabilities = await provider.detectCapabilities()

  const app = await buildServer({ config, credentials, provider, capabilities })
  await app.listen({ host: config.server.host, port: config.server.port })
  // Fastify's logger reports the listening address.

  // Close gracefully so the port is released on stop / dev hot-reload restart.
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down')
    await app.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

async function status(): Promise<void> {
  const { host, port } = loadConfig().server
  const reachable = host === '0.0.0.0' ? '127.0.0.1' : host
  const url = `http://${reachable}:${port}/health`
  try {
    const res = await fetch(url)
    console.log(`Timmy is up at ${url} →`, await res.json())
  } catch {
    console.log(`Timmy is not responding at ${url}`)
    process.exit(1)
  }
}

function usage(): void {
  console.log(`Timmy v${VERSION}\nUsage: timmy <start|status|version>`)
}

function main(): void {
  const cmd = process.argv[2]
  switch (cmd) {
    case 'start':
      void start()
      break
    case 'status':
      void status()
      break
    case 'version':
    case '--version':
    case '-v':
      console.log(`Timmy v${VERSION}`)
      break
    case undefined:
      usage()
      break
    default:
      console.error(`Unknown command: ${cmd}`)
      usage()
      process.exit(1)
  }
}

main()
