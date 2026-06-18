# Timmy

Modular, local-first personal AI assistant platform. A local LLM handles most conversations at $0; cloud reasoning (Claude / DeepSeek / Gemini / OpenAI) and agentic work (Claude Code) are called only on demand. Terminal-first — the full assistant runs in your shell; GUI and workflow tooling are optional layers on top.

> Deep design lives in the workspace `docs/` folder: `SYSTEM_DESIGN.md`, `TECH_STACK.md`, `DEVELOPMENT_PLAN.md`, `OLLAMA_GUIDE.md`.

## Install (macOS · Apple Silicon · beta)

```sh
curl -fsSL https://raw.githubusercontent.com/omatsetyadi/timmy/main/install.sh | sh
```

Downloads the single `timmy` binary to `~/.local/bin` (checksum-verified) — **no Node, no toolchain**. Then:

```sh
timmy init       # one-time setup: pick a provider/model, install default plugins
timmy start      # start the background daemon (HTTP/WS on 127.0.0.1:3737)
timmy chat       # talk to it in your terminal
```

Daemon lifecycle: `timmy start | stop | status | logs [-f]`, and `timmy autostart on` to launch at login.
Voice (optional, hands-free): `timmy voice install`, then `timmy voice start` (or `timmy voice autostart on` so it follows core).

> Beta is unsigned — on first run macOS may quarantine it; clear with `xattr -dr com.apple.quarantine ~/.local/bin/timmy`. Linux/Windows builds + code signing come later.

## Architecture

**Timmy is the "frontdesk"** — one top-level agent (think JARVIS) that you configure with a provider + model (Ollama, OpenAI, Anthropic, Gemini, DeepSeek, or Claude Code). It chats locally for free and reaches for more power only when needed:

- **`askModel`** — routes a hard question to a stronger reasoning model (safe-tier, auto-runs).
- **`askClaude`** — hands agentic work to Claude Code with its own tools — run a script, prep a DB, do dev work (confirm-tier: you approve before it acts).

**One shape everywhere: `(provider) + (toolset) + (loop)`.** The frontdesk, `askModel`, and `askClaude` are all instances of the same pattern, which keeps new capabilities _additive_ instead of forcing refactors.

**Layered, terminal-first modules** (SYSTEM_DESIGN §2.2):

| Layer                  | Status         | What it is                                                                     |
| ---------------------- | -------------- | ------------------------------------------------------------------------------ |
| **Core — CLI + voice** | required       | the daemon + terminal chat + (bundled) voice. A complete assistant on its own. |
| **Dashboard GUI**      | optional       | Electron app for chat/settings/management.                                     |
| **Workflow platform**  | optional       | builder / scheduler / integrations for users who want them.                    |
| **Plugins**            | bring-your-own | tools + workflows anyone can add (see below).                                  |

**Daemon + clients.** `timmy start` runs the background daemon (HTTP/WebSocket on `127.0.0.1:3737`, SQLite persistence, Effect-TS core). The CLI is a thin client of it: `timmy chat` (interactive REPL), `timmy model …` (configure providers/models), `timmy plugin …`, `timmy init`, `timmy status`.

**Tools** come from two sources merged into one registry — built-in core tools (`askModel`, `askClaude`) and **plugin tools** — each carrying a risk tier (`safe` auto-runs · `confirm` asks first · `blocked` disabled). Plugin tools are namespaced `<plugin>__<tool>` so they never collide and stay valid as cloud-provider function names.

## Extending Timmy (plugins)

Timmy is built to be extended by writing a plugin — a small package that exports tools against a stable, versioned contract. **Start here: [`packages/sdk/README.md`](packages/sdk/README.md)** — the full plugin-author guide (contract, `apiVersion`, naming rules, risk tiers, credentials, `ToolContext`).

Reusable capability libraries (OS/machine control, etc.) live in the separate [`agent-tool-calls`](https://github.com/omatsetyadi/agent-tool-calls) repo; Timmy plugins are thin adapters over them. Install a plugin with `timmy plugin install github:user/repo` — it **fetches the prebuilt, checksum-verified bundle from the plugin's GitHub Release** (no clone/build on your machine). `timmy plugin install ./dist` installs a local build for plugin development.

## Monorepo layout

```
packages/
  sdk/     timmy-sdk  — the plugin contract: shared types + interfaces (published to npm)
  core/    timmy-core — the daemon (HTTP/WS server, LLM providers, tool registry, persistence) + CLI
```

Voice ships as a separate Python daemon ([`timmy-voice`](https://github.com/omatsetyadi/timmy-voice) — STT/TTS/wake-word) that `timmy voice install` sets up and core supervises; it talks to core over the same `/stream` contract. Still planned: `timmy-dashboard` (Electron) + the workflow platform. See `docs/DEVELOPMENT_PLAN.md` for the roadmap.

## Develop

```bash
corepack enable pnpm # activate the pinned pnpm (first time only)
pnpm install         # install workspace deps
pnpm dev             # run timmy-core in watch mode (turbo → tsx) — the daemon, hot-reloading on save
pnpm build           # build all packages (turbo, cached)
pnpm start           # run built timmy-core (daemon on 127.0.0.1:3737)
pnpm typecheck       # turbo (also runs on pre-commit)
pnpm lint            # eslint (also runs on pre-commit, --fix on staged files)
pnpm format          # prettier --write
```

To use the CLI against a running daemon: in one shell `pnpm start` (or `pnpm dev`), in another `node packages/core/dist/index.js chat`.

Tooling: **pnpm** workspaces + **Turborepo** task orchestration. A husky **pre-commit** hook runs typecheck + lint + prettier on staged files. Requires **Node.js 24+** (see `.nvmrc`; run `nvm use`).
