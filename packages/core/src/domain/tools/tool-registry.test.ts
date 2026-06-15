import { it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { expect } from 'vitest'
import { Platform, type Tool } from 'timmy-sdk'
import { CredentialStore } from '../credentials/credential-store'
import { Config } from '../config/config'
import { ToolRegistry } from './tool-registry'
import { ToolSource } from './tool-source'

// Config with no file → defaults (permissions { mode: 'default' }).
const NoConfig = Config.Live('/nonexistent/timmy-test.yaml')

const echo: Tool = {
  name: 'echo',
  description: 'echoes',
  riskLevel: 'safe',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: async (args) => ({ ok: true, data: args.text }),
}

// A CredentialStore stub that resolves a non-null value for ANY key, so the scoping
// assertion is meaningful: a blocked key returns null only because the registry refused
// to ask the store, not because the store had nothing under it.
const CredStub = Layer.succeed(CredentialStore, {
  get: (k: string) => Effect.succeed(`secret-for-${k}`),
  set: () => Effect.void,
  delete: () => Effect.void,
})

const layer = ToolRegistry.Live.pipe(
  Layer.provide(ToolSource.layer([echo])),
  Layer.provide(CredStub),
  Layer.provide(NoConfig),
)

it.effect('lists tools, exposes model schemas, executes by name', () =>
  Effect.gen(function* () {
    const reg = yield* ToolRegistry
    expect(reg.toModelTools()[0]).toMatchObject({ type: 'function', function: { name: 'echo' } })
    const result = yield* reg.execute('echo', { text: 'hi' })
    expect(result).toEqual({ ok: true, data: 'hi' })
  }).pipe(Effect.provide(layer)),
)

it.effect('fails with ToolNotFoundError for unknown tool', () =>
  Effect.gen(function* () {
    const reg = yield* ToolRegistry
    const r = yield* Effect.either(reg.execute('nope', {}))
    expect(r._tag).toBe('Left')
  }).pipe(Effect.provide(layer)),
)

// A tool that reports back what it could read from its (scoped) credential context.
const needsCred: Tool = {
  name: 'needsCred',
  description: 'reads credentials',
  riskLevel: 'safe',
  parameters: { type: 'object', properties: {} },
  execute: async (_args, ctx) => {
    const declared = await ctx.credentials.get('declared')
    const other = await ctx.credentials.get('other')
    return { ok: true, data: { declared, other } }
  },
}

// ToolSource carries the per-tool credential scope: plugin 'p' declared only ['declared'].
const scopedSource = Layer.succeed(ToolSource, {
  tools: [needsCred],
  credentialScopeByTool: new Map([['needsCred', { plugin: 'p', keys: ['declared'] }]]),
})
const scopedLayer = ToolRegistry.Live.pipe(
  Layer.provide(scopedSource),
  Layer.provide(CredStub),
  Layer.provide(NoConfig),
)

// A blocked-tier tool must never reach the model (hidden from list + toModelTools).
const blockedTool: Tool = {
  name: 'danger',
  description: 'blocked',
  riskLevel: 'blocked',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ ok: true }),
}
const blockedLayer = ToolRegistry.Live.pipe(
  Layer.provide(ToolSource.layer([echo, blockedTool])),
  Layer.provide(CredStub),
  Layer.provide(NoConfig),
)
it.effect('hides blocked tools from the model (list + toModelTools)', () =>
  Effect.gen(function* () {
    const reg = yield* ToolRegistry
    expect(reg.list().map((t) => t.name)).toEqual(['echo'])
    expect(reg.toModelTools().map((t) => t.function.name)).toEqual(['echo'])
  }).pipe(Effect.provide(blockedLayer)),
)

// A tool that reports the platform it received from its execution context.
const reportsPlatform: Tool = {
  name: 'plat',
  description: 'reports platform',
  riskLevel: 'safe',
  parameters: { type: 'object', properties: {} },
  execute: async (_args, ctx) => ({ ok: true, data: ctx.platform }),
}
const platLayer = ToolRegistry.Live.pipe(
  Layer.provide(ToolSource.layer([reportsPlatform])),
  Layer.provide(CredStub),
  Layer.provide(NoConfig),
)
it.effect('passes the current platform into the tool execution context', () =>
  Effect.gen(function* () {
    const reg = yield* ToolRegistry
    const r = yield* reg.execute('plat', {})
    expect([Platform.MAC, Platform.WINDOWS, Platform.LINUX]).toContain(r.data)
  }).pipe(Effect.provide(platLayer)),
)

it.effect(
  'scopes credentials to the owning plugin: declared keys resolve, others are blocked',
  () =>
    Effect.gen(function* () {
      const reg = yield* ToolRegistry
      const result = yield* reg.execute('needsCred', {})
      const data = (result.data ?? {}) as { declared: string | null; other: string | null }
      // 'declared' is in the plugin's declared keys → resolved via the store under 'p:declared'.
      expect(data.declared).toBe('secret-for-p:declared')
      // 'other' was NOT declared → blocked even though the store would have returned a value.
      expect(data.other).toBeNull()
    }).pipe(Effect.provide(scopedLayer)),
)
