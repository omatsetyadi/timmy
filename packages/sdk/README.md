# timmy-sdk

The plugin contract for [Timmy](https://github.com/omatsetyadi/timmy). A Timmy plugin is a
small package that exports a default `TimmyPlugin` — a named bundle of **tools** the assistant
(and the models it routes to) can call. The SDK is intentionally zero-dependency and framework-free:
your plugin depends only on `timmy-sdk`.

## Quick start

```ts
import { PLUGIN_API_VERSION, type TimmyPlugin } from 'timmy-sdk'

const plugin: TimmyPlugin = {
  apiVersion: PLUGIN_API_VERSION, // required — the contract version you built against
  name: 'my-plugin', // kebab-case, see naming rules below
  version: '0.1.0',
  // Optional: declare the credential keys your tools may read (least-privilege).
  credentials: [{ key: 'api_token', label: 'API token', type: 'secret' }],
  tools: [
    {
      name: 'greet',
      description: 'Say hello to a name.',
      riskLevel: 'safe', // 'safe' | 'confirm' | 'blocked'
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'who to greet' } },
        required: ['name'],
      },
      execute: async (args, ctx) => {
        // ctx = { credentials, signal, platform }
        const token = await ctx.credentials.get('api_token') // null unless declared above
        return { ok: true, data: `hello ${args.name} (on ${ctx.platform})` }
      },
    },
  ],
}

export default plugin
```

Build to a self-contained `dist/index.js` (e.g. with tsup) and install:
`timmy plugin install ./my-plugin` or `timmy plugin install github:you/my-plugin`.

## The contract

### `apiVersion` (required)

Set `apiVersion: PLUGIN_API_VERSION`. The host accepts a supported range and **skips**
incompatible plugins with a clear log — it never crashes. A plugin that declares **no**
`apiVersion` is currently still loaded with a **deprecation warning** (migration runway);
don't rely on that — always set it.

### Naming rules (enforced at load; a violating plugin is skipped)

These exist because a tool's name is sent verbatim to cloud model providers (OpenAI, DeepSeek,
Anthropic, Gemini) as a function name, and those reject anything outside `^[a-zA-Z0-9_-]{1,64}$`.

- **Plugin name** — kebab-case only: `^[a-z0-9-]+$` (e.g. `my-plugin`, `omat-workflow`). No
  uppercase, spaces, dots, or colons. The name also prefixes your credential namespace.
- **Tool name** — `^[a-zA-Z0-9_-]+$` and must **not** contain `__` (double underscore).
- **Model-facing name** — the host exposes each of your tools to the model as
  **`<plugin>__<tool>`** (e.g. `my-plugin__greet`). The composite must fit in 64 chars; an
  over-long tool is dropped. Two installed plugins with the same name → the first wins, the
  later is skipped.

### Risk levels

- `safe` — runs without a prompt.
- `confirm` — the user is asked to approve before it runs (surfaced inline in `timmy chat`).
- `blocked` — never runs (declare-but-disable).

### Credentials (least-privilege)

Declare keys in `credentials[]`. At runtime `ctx.credentials.get(key)` resolves **only** keys
your plugin declared, stored in the OS keychain under `"<plugin>:<key>"`. Undeclared keys (and
another plugin's keys) always return `null`.

### `ToolContext`

Every `execute(args, ctx)` receives:

- `ctx.credentials.get(key)` — scoped credential lookup (above).
- `ctx.signal` — an `AbortSignal` that fires when the turn is cancelled; honor it for long work.
- `ctx.platform` — `'mac' | 'windows' | 'linux'`, so cross-platform plugins can branch without
  importing any OS package.

### Tool result

Return `{ ok: true, data?: unknown }` on success, or `{ ok: false, error: string }` on failure.
**Report failure honestly** — if you can't do the requested thing, return `ok: false` with a
reason rather than a bare `ok`, so the assistant doesn't claim a success that didn't happen.

## Resilience

One bad plugin never blocks the rest or crashes Timmy: import errors, schema violations,
incompatible `apiVersion`, illegal names, and name collisions are each logged and skipped.
