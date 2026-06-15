import { it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { describe, it as itV, expect } from 'vitest'
import { setKey, statusReport, buildInitConfig } from './model-cli'
import { CredentialStore } from '../domain/credentials/credential-store'
import { Config } from '../domain/config/config'
import { ProviderRegistry } from '../domain/llm/provider-registry'

const TestCreds = Layer.sync(CredentialStore, () => {
  const store = new Map<string, string>()
  return {
    get: (k: string) => Effect.sync(() => store.get(k) ?? null),
    set: (k: string, v: string) => Effect.sync(() => void store.set(k, v)),
    delete: (k: string) => Effect.sync(() => void store.delete(k)),
  }
})

const TestProviderRegistry = Layer.succeed(ProviderRegistry, {
  pool: Effect.succeed([]),
  refresh: Effect.succeed([]),
})

it.effect('setKey stores under model:<provider>:api_key', () =>
  Effect.gen(function* () {
    yield* setKey('deepseek', 'sk-123')
    const got = yield* (yield* CredentialStore).get('model:deepseek:api_key')
    expect(got).toBe('sk-123')
  }).pipe(Effect.provide(TestCreds)),
)

it.effect('statusReport lists providers with availability + discovered models', () =>
  Effect.gen(function* () {
    const report = yield* statusReport
    expect(report.frontdesk).toBeDefined()
    expect(Array.isArray(report.providers)).toBe(true)
  }).pipe(Effect.provide(Layer.mergeAll(TestCreds, Config.Live(), TestProviderRegistry))),
)

describe('buildInitConfig (timmy init → config object)', () => {
  itV(
    'ollama frontdesk → no providers block (ollama is implicit); claude_code added when authed',
    () => {
      expect(
        buildInitConfig({
          frontdesk: { provider: 'ollama', model: 'qwen3:14b' },
          claudeAuthed: true,
        }),
      ).toEqual({
        models: { frontdesk: { provider: 'ollama', model: 'qwen3:14b' } },
        providers: { claude_code: { kind: 'claude-code' } },
      })
    },
  )
  itV('ollama frontdesk, no claude → no providers block at all', () => {
    expect(
      buildInitConfig({
        frontdesk: { provider: 'ollama', model: 'qwen3:14b' },
        claudeAuthed: false,
      }),
    ).toEqual({
      models: { frontdesk: { provider: 'ollama', model: 'qwen3:14b' } },
    })
  })
  itV('cloud frontdesk → adds the cloud provider (base_url auto-resolved at boot)', () => {
    expect(
      buildInitConfig({
        frontdesk: { provider: 'deepseek', model: 'deepseek-v4-flash' },
        claudeAuthed: false,
        cloudProvider: 'deepseek',
      }),
    ).toEqual({
      models: { frontdesk: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
      providers: { deepseek: { kind: 'openai-compat' } },
    })
  })
})
