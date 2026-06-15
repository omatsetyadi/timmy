import { Effect } from 'effect'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { CONFIG_DIR, readConfigSync } from '../domain/config/config'
import { ProviderRegistry } from '../domain/llm/provider-registry'
import { hasBuiltEntry, installFromGithub, installLocal, listInstalled, remove } from './plugin-cli'
import {
  setKey,
  statusReport,
  setFrontdeskConfig,
  setReasoningConfig,
  setAskClaudeModel,
  setAskClaudeBypass,
  discoveredTargetIds,
} from './model-cli'
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

/** `timmy model <set-key <provider>|status|refresh>` — manage cloud model providers. */
async function model(args: readonly string[]): Promise<void> {
  const sub = args[0]
  const { runtime } = buildRuntime()
  try {
    if (sub === 'set-key') {
      const provider = args[1]
      if (!provider) {
        console.error('Usage: timmy model set-key <provider>')
        process.exit(1)
      }
      // read the key from stdin (one line, on Enter) so it never lands in shell history
      const key = await new Promise<string>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        rl.question(`Paste the API key for '${provider}' and press Enter:\n`, (answer) => {
          rl.close()
          resolve(answer.trim())
        })
      })
      await runtime.runPromise(setKey(provider, key))
      console.log(`stored key for '${provider}'`)
    } else if (sub === 'status' || sub === 'list') {
      const r = await runtime.runPromise(statusReport)
      console.log(JSON.stringify(r, null, 2))
    } else if (sub === 'refresh') {
      const r = await runtime.runPromise(
        ProviderRegistry.pipe(Effect.flatMap((reg) => reg.refresh)),
      )
      console.log(`discovered ${r.length} targets`)
    } else if (sub === 'use') {
      const target = args[1]
      if (!target || !target.includes('/')) {
        console.error('Usage: timmy model use <provider>/<model>')
        process.exit(1)
      }
      const ids = await runtime.runPromise(discoveredTargetIds)
      if (!ids.includes(target)) {
        console.error(
          `'${target}' is not an available model.\nDiscovered: ${ids.join(', ') || '(none — check provider config + keys, then `timmy model refresh`)'}`,
        )
        process.exit(1)
      }
      const slash = target.indexOf('/')
      setFrontdeskConfig(target.slice(0, slash), target.slice(slash + 1))
      console.log(`frontdesk → ${target}   (restart \`timmy start\` to apply)`)
    } else if (sub === 'reasoning') {
      const target = args[1]
      if (target === '--clear') {
        setReasoningConfig(null)
        console.log('reasoning default cleared   (restart `timmy start` to apply)')
      } else if (!target || !target.includes('/')) {
        console.error('Usage: timmy model reasoning <provider>/<model> | --clear')
        process.exit(1)
      } else {
        const ids = await runtime.runPromise(discoveredTargetIds)
        if (!ids.includes(target)) {
          console.error(
            `'${target}' is not an available model.\nDiscovered: ${ids.join(', ') || '(none)'}`,
          )
          process.exit(1)
        }
        setReasoningConfig(target)
        console.log(`reasoning default → ${target}   (restart \`timmy start\` to apply)`)
      }
    } else if (sub === 'askclaude') {
      const claudeModel = args[1]
      if (!claudeModel) {
        console.error('Usage: timmy model askclaude <claude-model>   (e.g. claude-opus-4-8)')
        process.exit(1)
      }
      setAskClaudeModel(claudeModel)
      console.log(
        `askClaude model → ${claudeModel}   (restart \`timmy start\`; needs Claude Code installed + logged in)`,
      )
    } else if (sub === 'auto') {
      const v = args[1]
      if (v !== 'on' && v !== 'off') {
        console.error('Usage: timmy model auto <on|off>')
        process.exit(1)
      }
      setAskClaudeBypass(v === 'on')
      console.log(
        v === 'on'
          ? 'askClaude auto-mode ON — Claude Code may use ANY tool, no allowlist   (restart `timmy start`)'
          : 'askClaude auto-mode OFF — scoped allowlist (Read/Glob/Grep/Bash/Edit/Write)   (restart `timmy start`)',
      )
    } else {
      console.error(
        'Usage: timmy model <set-key <provider> | use <provider>/<model> | reasoning <provider>/<model>|--clear | askclaude <claude-model> | auto <on|off> | status | refresh>',
      )
      process.exit(1)
    }
  } finally {
    await runtime.dispose()
  }
}

function printHelp(): void {
  console.log(`Timmy v${VERSION} — local-first personal AI assistant

Usage: timmy <command> [args]

Core:
  start                              Start the Timmy daemon (HTTP + WebSocket server)
  status                             Check whether the running daemon is reachable
  help, --help, -h                   Show this help
  version, --version, -v             Print the version

Plugins:
  plugin install <path|github:user/repo>   Install a plugin (local dir or GitHub repo)
  plugin list                        List installed plugins
  plugin remove <name>               Remove an installed plugin

Models (cloud + local LLM providers):
  model set-key <provider>           Store a provider API key in the keychain (reads stdin)
  model use <provider>/<model>       Set the frontdesk model (validated against discovered)
  model reasoning <provider>/<model> Set the askModel default target (or --clear)
  model askclaude <claude-model>     Set the model askClaude runs (e.g. claude-opus-4-8)
  model auto <on|off>                Toggle askClaude auto-mode (any tool, no allowlist)
  model status                       Show providers, discovered models, frontdesk + reasoning
  model list                         Alias of \`model status\`
  model refresh                      Re-run model auto-discovery

  Note: askClaude (agentic Claude Code) needs the \`claude\` CLI installed + logged in
  (\`claude auth status\`; \`model status\` shows availability + auto-mode state).

Config: ~/.timmy/config.yaml   ·   Plugins: ~/.timmy/plugins/`)
}

export function run(): void {
  const cmd = process.argv[2]
  if (cmd === 'start') void start()
  else if (cmd === 'status') void status()
  else if (cmd === 'plugin') plugin(process.argv.slice(3))
  else if (cmd === 'model') void model(process.argv.slice(3))
  else if (cmd === 'version' || cmd === '--version' || cmd === '-v')
    console.log(`Timmy v${VERSION}`)
  else if (cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === undefined) printHelp()
  else {
    console.error(`Unknown command: ${cmd}\nRun \`timmy help\` to see available commands.`)
    process.exit(1)
  }
}
