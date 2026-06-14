import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR, readConfigSync } from '../domain/config/config'
import { hasBuiltEntry, installFromGithub, installLocal, listInstalled, remove } from './plugin-cli'
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
  // Read config only — a health ping must not build the full runtime (which would
  // open the DB and load plugins from disk just to learn the host/port).
  const config = readConfigSync()
  const host = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host
  const url = `http://${host}:${config.server.port}/health`
  try {
    console.log(`Timmy is up at ${url} →`, await (await fetch(url)).json())
  } catch {
    console.log(`Timmy is not responding at ${url}`)
    process.exit(1)
  }
}

/** `timmy plugin <install <path>|list|remove <name>>` — synchronous fs + console work,
 *  no Effect runtime needed. Plugins live under `<CONFIG_DIR>/plugins/`. */
function plugin(args: readonly string[]): void {
  const pluginsDir = join(CONFIG_DIR, 'plugins')
  const sub = args[0]

  if (sub === 'install') {
    const src = args[1]
    if (src === undefined) {
      console.error('Usage: timmy plugin install <path>')
      process.exit(1)
    }
    mkdirSync(pluginsDir, { recursive: true })
    // github:user/repo → clone + `npm install` + build at the target (resolving the
    // published deps), then install the built bundle.
    if (src.startsWith('github:')) {
      const name = installFromGithub(src, pluginsDir)
      console.log(`installed '${name}' from ${src} → ${join(pluginsDir, name)}`)
      return
    }
    // Any OTHER scheme (https:, npm:, file:, …) is unsupported. RFC-3986 scheme shape:
    // a letter then 1+ scheme chars (the `+` requires length ≥2), so it catches schemes
    // while letting Windows drive letters (C:\…) through as local paths.
    if (/^[a-z][a-z0-9+.-]+:/i.test(src)) {
      console.error(`'${src}' — only a local path or github:user/repo is supported`)
      process.exit(1)
    }
    if (!hasBuiltEntry(src)) {
      console.error(
        `plugin at ${src} has no dist/index.js (or index.js) — build it first (pnpm build)`,
      )
      process.exit(1)
    }
    const name = installLocal(src, pluginsDir)
    console.log(`installed '${name}' → ${join(pluginsDir, name)}`)
    return
  }

  if (sub === 'list') {
    const names = listInstalled(pluginsDir)
    console.log(names.length === 0 ? 'no plugins installed' : names.join('\n'))
    return
  }

  if (sub === 'remove') {
    const name = args[1]
    if (name === undefined) {
      console.error('Usage: timmy plugin remove <name>')
      process.exit(1)
    }
    if (remove(pluginsDir, name)) console.log(`removed '${name}'`)
    else {
      console.error(`plugin '${name}' not found`)
      process.exit(1)
    }
    return
  }

  console.error('Usage: timmy plugin <install <path>|list|remove <name>>')
  process.exit(1)
}

export function run(): void {
  const cmd = process.argv[2]
  if (cmd === 'start') void start()
  else if (cmd === 'status') void status()
  else if (cmd === 'plugin') plugin(process.argv.slice(3))
  else if (cmd === 'version' || cmd === '--version' || cmd === '-v')
    console.log(`Timmy v${VERSION}`)
  else if (cmd === undefined)
    console.log(`Timmy v${VERSION}\nUsage: timmy <start|status|plugin|version>`)
  else {
    console.error(`Unknown command: ${cmd}`)
    process.exit(1)
  }
}
