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
npm install          # install workspace deps
npm run build        # build all packages
npm start            # run timmy-core → prints "Timmy v0.1.0"
npm run lint
npm run format
```

Requires Node.js 24+ (current LTS — see `.nvmrc`; run `nvm use`).
