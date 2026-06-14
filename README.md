# Timmy

Modular, local-first personal AI assistant platform. A local LLM handles most conversations at $0; cloud reasoning (Claude / DeepSeek / etc.) is called only on demand.

> Design docs live in the workspace `docs/` folder: `SYSTEM_DESIGN.md`, `TECH_STACK.md`, `DEVELOPMENT_PLAN.md`, `OLLAMA_GUIDE.md`.

## Monorepo layout

```
packages/
  sdk/                 timmy-sdk — shared types + plugin interface contracts (published to npm)
  core/                timmy-core — background daemon (HTTP/WS server, LLM, tools, memory)
  modules/
    voice/             timmy-voice (Python, optional) — STT/TTS/wake-word
    dashboard/         timmy-dashboard (Electron, optional)
    web/               timmy-web (Next.js, optional)
```

Tool logic lives in the separate [`agent-tool-calls`](https://github.com/omatsetyadi/agent-tool-calls) repo; Timmy plugins are thin adapters over it.

## Develop

```bash
corepack enable pnpm # activate the pinned pnpm (first time only)
pnpm install         # install workspace deps
pnpm dev             # run timmy-core in watch mode (turbo → tsx) — hot reloads on save
pnpm build           # build all packages (turbo, cached)
pnpm start           # run built timmy-core (server on 127.0.0.1:3737)
pnpm typecheck       # turbo (also runs on pre-commit)
pnpm lint            # eslint (also runs on pre-commit, --fix on staged files)
pnpm format          # prettier --write
```

Tooling: **pnpm** workspaces + **Turborepo** task orchestration. A husky **pre-commit** hook runs typecheck + lint + prettier on staged files.

Requires Node.js 24+ (current LTS — see `.nvmrc`; run `nvm use`).
