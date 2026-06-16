import { Effect } from 'effect'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  CONFIG_DIR,
  CONFIG_PATH,
  Permission,
  PermissionMode,
  readConfigSync,
} from '../domain/config/config'
import { ProviderRegistry } from '../domain/llm/provider-registry'
import {
  DEFAULT_PLUGINS,
  hasBuiltEntry,
  installDefaults,
  installFromGithub,
  installLocal,
  isGithubSource,
  listInstalled,
  readInstalledManifest,
  remove,
} from './plugin-cli'
import {
  setKey,
  setPluginKey,
  registerKnownProvider,
  statusReport,
  setFrontdeskConfig,
  setReasoningConfig,
  setVisionConfig,
  setAskClaudeModel,
  setAskClaudeBypass,
  discoveredTargetIds,
  detectEnv,
  writeInitConfig,
  type InitChoices,
} from './model-cli'
import { addAllowedCommand, setMode, setOverride } from './permission-cli'
import { memory } from './memory-cli'
import { profile } from './profile-cli'
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

/** `timmy plugin <install <path>|list|remove <name>|set-key <plugin> <key>>`. install/list/remove
 *  are synchronous fs work; set-key needs the runtime (keychain). Plugins live under
 *  `<CONFIG_DIR>/plugins/`. */
/** After install, surface what the plugin gives you (tools) and what it NEEDS (declared API
 *  keys) + the exact set-key command — so a key requirement is discoverable, not buried. */
async function reportInstalled(pluginsDir: string, installedDir: string): Promise<void> {
  const m = await readInstalledManifest(join(pluginsDir, installedDir))
  if (!m) return
  if (m.tools.length) console.log(`  tools: ${m.tools.join(', ')}`)
  if (m.credentialKeys.length) {
    console.log(`  needs API key${m.credentialKeys.length > 1 ? 's' : ''} — set with:`)
    for (const k of m.credentialKeys) console.log(`    timmy plugin set-key ${m.name} ${k}`)
  }
}

async function plugin(args: readonly string[]): Promise<void> {
  const pluginsDir = join(CONFIG_DIR, 'plugins')
  const sub = args[0]

  // Set a plugin's API key under the `<plugin>:<key>` convention its scoped credentials read.
  if (sub === 'set-key') {
    const pluginName = args[1]
    const credKey = args[2]
    if (!pluginName || !credKey) {
      console.error('Usage: timmy plugin set-key <plugin> <key>   (e.g. web tavily_api_key)')
      process.exit(1)
    }
    const value = await new Promise<string>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      rl.question(`Paste the value for '${pluginName}:${credKey}' and press Enter:\n`, (a) => {
        rl.close()
        resolve(a.trim())
      })
    })
    const { runtime } = buildRuntime()
    try {
      await runtime.runPromise(setPluginKey(pluginName, credKey, value))
      console.log(`stored '${pluginName}:${credKey}'   (restart Timmy to apply)`)
    } finally {
      await runtime.dispose()
    }
    return
  }

  if (sub === 'install') {
    const src = args[1]
    if (src === undefined) {
      console.error('Usage: timmy plugin install <path|github:user/repo|github-url>')
      process.exit(1)
    }
    mkdirSync(pluginsDir, { recursive: true })
    // Any GitHub source (github:user/repo shorthand, https://github.com/... URL, or
    // git@github.com: SSH) → clone + `npm install` + build at the target (resolving the
    // published deps), then install the built bundle.
    if (isGithubSource(src)) {
      const name = installFromGithub(src, pluginsDir)
      console.log(`installed '${name}' from ${src} → ${join(pluginsDir, name)}`)
      await reportInstalled(pluginsDir, name)
      return
    }
    // Any OTHER scheme (npm:, file:, a non-GitHub git host, …) is unsupported. RFC-3986 scheme
    // shape: a letter then 1+ scheme chars (the `+` requires length ≥2), so it catches schemes
    // while letting Windows drive letters (C:\…) through as local paths.
    if (/^[a-z][a-z0-9+.-]+:/i.test(src)) {
      console.error(
        `'${src}' — only a local path or a GitHub repo (github:user/repo or a github.com URL) is supported`,
      )
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
    await reportInstalled(pluginsDir, name)
    return
  }

  if (sub === 'list') {
    const names = listInstalled(pluginsDir)
    if (names.length === 0) {
      console.log('no plugins installed')
      return
    }
    for (const n of names) {
      const m = await readInstalledManifest(join(pluginsDir, n))
      const needs = m && m.credentialKeys.length ? `  (needs: ${m.credentialKeys.join(', ')})` : ''
      console.log(`${n}${needs}`)
    }
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

  console.error(
    'Usage: timmy plugin <install <path|github-url>|list|remove <name>|set-key <plugin> <key>>',
  )
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
      // Known cloud providers (openai/deepseek/anthropic/gemini) auto-register as a usable
      // provider so they show up + can be selected without a manual config edit.
      if (registerKnownProvider(provider)) {
        console.log(
          `registered '${provider}' (openai-compat) — run \`timmy model refresh\` to discover its models`,
        )
      } else {
        console.log(
          `note: '${provider}' is custom — add it to ~/.timmy/config.yaml under \`providers:\` with a base_url`,
        )
      }
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
      console.log(`frontdesk → ${target}   (restart Timmy to apply)`)
    } else if (sub === 'reasoning') {
      const target = args[1]
      if (target === '--clear') {
        setReasoningConfig(null)
        console.log('reasoning default cleared   (restart Timmy to apply)')
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
        console.log(`reasoning default → ${target}   (restart Timmy to apply)`)
      }
    } else if (sub === 'vision') {
      const target = args[1]
      if (!target || !target.includes('/')) {
        console.error('Usage: timmy model vision <provider>/<model>   (e.g. ollama/llava)')
        process.exit(1)
      }
      // No discovered-target check: if the model can't actually do vision, askVision degrades
      // gracefully at use time (answers "can't" → delegate) rather than gating config here.
      setVisionConfig(target)
      console.log(`vision model → ${target}   (restart Timmy to apply)`)
    } else if (sub === 'askclaude') {
      const claudeModel = args[1]
      if (!claudeModel) {
        console.error('Usage: timmy model askclaude <claude-model>   (e.g. claude-opus-4-8)')
        process.exit(1)
      }
      setAskClaudeModel(claudeModel)
      console.log(
        `askClaude model → ${claudeModel}   (restart Timmy; needs Claude Code installed + logged in)`,
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
          ? 'askClaude auto-mode ON — Claude Code may use ANY tool, no allowlist   (restart Timmy)'
          : 'askClaude auto-mode OFF — scoped allowlist (Read/Glob/Grep/Bash/Edit/Write)   (restart Timmy)',
      )
    } else {
      console.error(
        'Usage: timmy model <set-key <provider> | use <provider>/<model> | reasoning <provider>/<model>|--clear | vision <provider>/<model> | askclaude <claude-model> | auto <on|off> | status | refresh>',
      )
      process.exit(1)
    }
  } finally {
    await runtime.dispose()
  }
}

/** `timmy permission <status|set|mode|allow>` — manage the allow/ask/block permission system. */
function permission(args: readonly string[]): void {
  const sub = args[0]
  const PERMS = Object.values(Permission) as string[]
  if (sub === 'status') {
    console.log(JSON.stringify(readConfigSync().permissions, null, 2))
  } else if (sub === 'mode') {
    const m = args[1]
    if (m !== PermissionMode.DEFAULT && m !== PermissionMode.YOLO) {
      console.error('Usage: timmy permission mode <default|yolo>')
      process.exit(1)
    }
    setMode(m)
    console.log(`permission mode → ${m}   (restart Timmy to apply)`)
  } else if (sub === 'set') {
    const target = args[1]
    const perm = args[2]
    if (!target || !perm || !PERMS.includes(perm)) {
      console.error('Usage: timmy permission set <tool|plugin:NAME> <allow|ask|block>')
      process.exit(1)
    }
    if (target.startsWith('plugin:')) {
      setOverride('plugin', target.slice('plugin:'.length), perm as Permission)
    } else {
      setOverride('tool', target, perm as Permission)
    }
    console.log(`permission ${target} → ${perm}   (restart Timmy to apply)`)
  } else if (sub === 'allow') {
    const cmd = args.slice(1).join(' ').trim()
    if (!cmd) {
      console.error('Usage: timmy permission allow <command>')
      process.exit(1)
    }
    addAllowedCommand(cmd)
    console.log(`allowlisted command → "${cmd}"   (restart Timmy to apply)`)
  } else {
    console.error(
      'Usage: timmy permission <status | set <tool|plugin:NAME> <allow|ask|block> | mode <default|yolo> | allow <command>>',
    )
    process.exit(1)
  }
}

/** `timmy yolo <on|off>` — friendly alias for `permission mode default|yolo`. */
function yolo(args: readonly string[]): void {
  const v = args[0]
  if (v !== 'on' && v !== 'off') {
    console.error('Usage: timmy yolo <on|off>')
    process.exit(1)
  }
  setMode(v === 'on' ? PermissionMode.YOLO : PermissionMode.DEFAULT)
  console.log(
    v === 'on'
      ? 'YOLO ON — risky commands auto-run with no confirm (blocked tools stay blocked)   (restart Timmy)'
      : 'YOLO OFF — normal mode (Timmy asks before risky actions)   (restart Timmy)',
  )
}

/** `timmy chat [--thread <id>]` — interactive terminal chat with the running daemon. */
async function chat(args: readonly string[]): Promise<void> {
  const i = args.indexOf('--thread')
  const threadArg = i >= 0 ? args[i + 1] : undefined
  // The Ink TUI ships as a tsup ESM bundle (Ink is ESM-only w/ top-level await; a static import
  // would crash the CJS build). Load it via dynamic import() at runtime.
  const appModule = './chat-tui/app.mjs'
  const { runChat } = (await import(appModule)) as typeof import('./chat-tui/app')
  await runChat({ threadArg })
}

/** `timmy init` — first-run setup (NOT daemon/PM2): detect env, pick a frontdesk, write config. */
async function init(): Promise<void> {
  const { runtime } = buildRuntime()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string): Promise<string> =>
    new Promise((res) => rl.question(q, (a) => res(a.trim())))
  try {
    if (existsSync(CONFIG_PATH)) {
      const ow = await ask('~/.timmy/config.yaml already exists. Overwrite? (y/N) ')
      if (ow.toLowerCase() !== 'y') {
        console.log('aborted — config unchanged')
        return
      }
    }
    console.log('Detecting environment…')
    const env = await runtime.runPromise(detectEnv)
    console.log(
      `  Ollama:      ${env.ollamaModels.length ? env.ollamaModels.join(', ') : 'not reachable on localhost:11434'}`,
    )
    console.log(
      `  Claude Code: ${env.claudeAuthed ? 'logged in (askClaude available)' : 'not detected'}`,
    )

    const options = env.ollamaModels.map((m) => `ollama/${m}`)
    console.log('\nPick a frontdesk model:')
    options.forEach((o, i) => console.log(`  [${i + 1}] ${o}`))
    console.log(`  [c]  a cloud model (I'll ask for an API key)`)
    const pick = await ask('Choose: ')

    let choices: InitChoices
    if (pick.toLowerCase() === 'c' || options.length === 0) {
      const provider = (
        await ask('  Cloud provider (deepseek/openai/anthropic/gemini): ')
      ).toLowerCase()
      const model = provider && (await ask(`  Model id for ${provider} (e.g. deepseek-v4-flash): `))
      if (!provider || !model) {
        console.error('aborted — provider and model are required')
        process.exit(1)
      }
      const key = await ask(`  Paste the ${provider} API key (Enter to skip for now): `)
      if (key) await runtime.runPromise(setKey(provider, key))
      choices = {
        frontdesk: { provider, model },
        claudeAuthed: env.claudeAuthed,
        cloudProvider: provider,
      }
    } else {
      const sel = options[Number(pick) - 1]
      if (!sel) {
        console.error('invalid choice')
        process.exit(1)
      }
      const slash = sel.indexOf('/')
      choices = {
        frontdesk: { provider: sel.slice(0, slash), model: sel.slice(slash + 1) },
        claudeAuthed: env.claudeAuthed,
      }
    }
    // Track what's already configured so the reasoning/optional steps don't re-ask for it.
    const configured = new Set<string>(
      [
        choices.frontdesk.provider,
        choices.cloudProvider,
        choices.claudeAuthed ? 'claude_code' : undefined,
      ].filter((p): p is string => Boolean(p)),
    )
    const extraProviders: string[] = []
    const addProvider = async (name: string, key: string): Promise<void> => {
      if (key) await runtime.runPromise(setKey(name, key))
      if (key && !configured.has(name)) {
        extraProviders.push(name)
        configured.add(name)
      }
    }

    // ── #3 Reasoning provider (askClaude) — Claude Code is the agentic reasoning engine when
    //    authed; an Anthropic key is the fallback (askModel / when Claude Code is unavailable).
    //    'anthropic' base_url auto-resolves at boot.
    console.log('\n─── Reasoning provider (askClaude) ───')
    console.log(
      env.claudeAuthed
        ? '  ✓ Claude Code — your agentic reasoning engine (askClaude). Add an Anthropic key as a fallback?'
        : '  Claude Code not detected — reasoning uses your frontdesk model. Add an Anthropic key for reasoning?',
    )
    await addProvider('anthropic', await ask('  Anthropic API key (Enter to skip): '))

    // ── #4 Optional providers — extra cloud keys for frontdesk-switching / reasoning fallback.
    console.log('\n─── Optional providers ───')
    console.log('  Add other provider keys (openai / gemini / deepseek / …), one at a time.')
    let askMore = true
    while (askMore) {
      const name = (await ask('  Provider name (Enter to finish): ')).toLowerCase()
      if (!name) askMore = false
      else if (configured.has(name)) console.log(`    ${name} already configured — skipped`)
      else await addProvider(name, await ask(`  ${name} API key (Enter to skip): `))
    }

    choices = { ...choices, extraProviders }
    writeInitConfig(choices)
    const extraNote = extraProviders.length ? ` · +${extraProviders.join(', ')}` : ''
    console.log(
      `\n✓ wrote ~/.timmy/config.yaml — frontdesk ${choices.frontdesk.provider}/${choices.frontdesk.model}` +
        (env.claudeAuthed ? ' · claude_code enabled (askClaude)' : '') +
        extraNote,
    )

    // Default plugins — so a fresh Timmy has hands, not an empty brain. Optional, and
    // continue-on-failure: the config above is already written, so a clone/build hiccup on one
    // plugin never aborts setup. Each install reuses the exact `plugin install` github path.
    const names = DEFAULT_PLUGINS.map((p) => p.name).join(', ')
    console.log(`\nRecommended plugins (${names}):`)
    DEFAULT_PLUGINS.forEach((p) => console.log(`  • ${p.name} — ${p.blurb}`))
    const wantPlugins = await ask('Install them now? (clones + builds each) (Y/n) ')
    if (wantPlugins.toLowerCase() !== 'n') {
      const pluginsDir = join(CONFIG_DIR, 'plugins')
      mkdirSync(pluginsDir, { recursive: true })
      const results = await installDefaults(
        DEFAULT_PLUGINS,
        async (p) => {
          const dir = installFromGithub(p.source, pluginsDir)
          await reportInstalled(pluginsDir, dir)
        },
        (m) => console.log(m),
      )
      const ok = results.filter((r) => r.ok).map((r) => r.name)
      const failed = results.filter((r) => !r.ok).map((r) => r.name)
      console.log(
        `\n  plugins: ${ok.length ? `✓ ${ok.join(', ')}` : 'none installed'}` +
          (failed.length ? ` · ✗ ${failed.join(', ')} (see above to retry)` : ''),
      )
    } else {
      console.log('  skipped — add later with `timmy plugin install github:<user>/<repo>`')
    }

    console.log(
      '\n  Next: `timmy start`  ·  `timmy model status`  ·  add keys: `timmy model set-key <provider>`',
    )
  } finally {
    rl.close()
    await runtime.dispose()
  }
}

function printHelp(): void {
  console.log(`Timmy v${VERSION} — local-first personal AI assistant

Usage: timmy <command> [args]

Core:
  init                               First-run setup wizard — detect env + write ~/.timmy/config.yaml
  start                              Start the Timmy daemon (HTTP + WebSocket server)
  chat [--thread <id>]               Interactive terminal chat with the running daemon
  status                             Check whether the running daemon is reachable
  help, --help, -h                   Show this help
  version, --version, -v             Print the version

Plugins:
  plugin install <path|github-url>   Install a plugin (local dir, github:user/repo, or a github.com URL)
  plugin list                        List installed plugins
  plugin remove <name>               Remove an installed plugin
  plugin set-key <plugin> <key>      Store a plugin API key (reads stdin), e.g. \`plugin set-key web tavily_api_key\`

Models (cloud + local LLM providers):
  model set-key <provider>           Store a provider API key in the keychain (reads stdin)
  model use <provider>/<model>       Set the frontdesk model (validated against discovered)
  model reasoning <provider>/<model> Set the askModel default target (or --clear)
  model vision <provider>/<model>    Set the askVision model (e.g. ollama/llava)
  model askclaude <claude-model>     Set the model askClaude runs (e.g. claude-opus-4-8)
  model auto <on|off>                Toggle askClaude auto-mode (any tool, no allowlist)
  model status                       Show providers, discovered models, frontdesk + reasoning
  model list                         Alias of \`model status\`
  model refresh                      Re-run model auto-discovery

Permissions (allow / ask / block — safe runs, risky asks, blocked is off):
  permission status                  Show the current permission posture
  permission set <tool|plugin:NAME> <allow|ask|block>   Override a tool or plugin
  permission mode <default|yolo>     default = ask on risky; yolo = auto-run risky
  permission allow <command>         Allowlist a shell command for runCommand (auto-run)
  yolo <on|off>                      Alias for \`permission mode yolo|default\`

Memory (the knowledge graph Timmy learns about you):
  memory list [--kind <k>]           List remembered entities (optionally filter by kind)
  memory show <id>                   Show an entity and its relations
  memory add --kind <k> --name <n> [--prop k=v ...]   Manually add an entity
  memory update <id> --prop k=v ...  Merge properties into an entity
  memory delete <id>                 Forget an entity
  memory learning <on|off|status>    Toggle whether Timmy learns from conversations

Profile (the assistant's identity + your own profile, injected into every system prompt):
  profile show                       Show both sections (assistant + you)
  profile set assistant name <t…>    Rename the assistant (default: Timmy)
  profile set assistant personality <t…>   Set the assistant's character/voice
  profile set user name <t…>         Your name (so it can address you)
  profile set user about <t…>        Who you are (grounding)
  profile set user style <t…>        How the assistant should respond to you
  profile set assistant language conversation <auto|English|…>   Reply language (auto = mirror user)
  profile set assistant language proactive <English|…>           Language for messages it starts
  profile set assistant language supported <en,id,ja>            Languages it may use (comma list)
  profile edit <assistant|user> <field>    Edit a field in $EDITOR
  profile clear <assistant|user> <field>   Unset a field

  Note: askClaude (agentic Claude Code) needs the \`claude\` CLI installed + logged in
  (\`claude auth status\`; \`model status\` shows availability + auto-mode state).

Config: ~/.timmy/config.yaml   ·   Plugins: ~/.timmy/plugins/`)
}

export function run(): void {
  const cmd = process.argv[2]
  if (cmd === 'start') void start()
  else if (cmd === 'init') void init()
  else if (cmd === 'chat') void chat(process.argv.slice(3))
  else if (cmd === 'status') void status()
  else if (cmd === 'plugin') void plugin(process.argv.slice(3))
  else if (cmd === 'model') void model(process.argv.slice(3))
  else if (cmd === 'permission') permission(process.argv.slice(3))
  else if (cmd === 'memory') void memory(process.argv.slice(3))
  else if (cmd === 'profile') profile(process.argv.slice(3))
  else if (cmd === 'yolo') yolo(process.argv.slice(3))
  else if (cmd === 'version' || cmd === '--version' || cmd === '-v')
    console.log(`Timmy v${VERSION}`)
  else if (cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === undefined) printHelp()
  else {
    console.error(`Unknown command: ${cmd}\nRun \`timmy help\` to see available commands.`)
    process.exit(1)
  }
}
