import { buildRuntime } from './runtime'
import { buildServer } from './server'

const VERSION = '0.1.0'

async function start(): Promise<void> {
  const { runtime, config } = buildRuntime()
  const app = await buildServer(config, runtime)
  await app.listen({ host: config.server.host, port: config.server.port })
  // Fastify's logger reports the listening address.

  const shutdown = async (sig: string): Promise<void> => {
    app.log.info({ sig }, 'shutting down')
    await app.close()
    await runtime.dispose()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

async function status(): Promise<void> {
  const { config } = buildRuntime()
  const host = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host
  const url = `http://${host}:${config.server.port}/health`
  try {
    console.log(`Timmy is up at ${url} →`, await (await fetch(url)).json())
  } catch {
    console.log(`Timmy is not responding at ${url}`)
    process.exit(1)
  }
}

export function run(): void {
  const cmd = process.argv[2]
  if (cmd === 'start') void start()
  else if (cmd === 'status') void status()
  else if (cmd === 'version' || cmd === '--version' || cmd === '-v')
    console.log(`Timmy v${VERSION}`)
  else if (cmd === undefined) console.log(`Timmy v${VERSION}\nUsage: timmy <start|status|version>`)
  else {
    console.error(`Unknown command: ${cmd}`)
    process.exit(1)
  }
}
