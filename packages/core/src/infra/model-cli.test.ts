import { it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { expect } from 'vitest'
import { setKey, statusReport } from './model-cli'
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
