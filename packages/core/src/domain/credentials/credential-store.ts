import { Entry } from '@napi-rs/keyring'
import { Context, Effect, Layer } from 'effect'
import { KeychainError } from './errors'

const SERVICE = 'timmy'

export class CredentialStore extends Context.Tag('timmy/credentials/store')<
  CredentialStore,
  {
    readonly get: (key: string) => Effect.Effect<string | null>
    readonly set: (key: string, value: string) => Effect.Effect<void, KeychainError>
    readonly delete: (key: string) => Effect.Effect<void>
  }
>() {
  static Live = Layer.succeed(CredentialStore, {
    get: (key) =>
      Effect.sync(() => {
        try {
          return new Entry(SERVICE, key).getPassword()
        } catch {
          return null
        }
      }),
    set: (key, value) =>
      Effect.try({
        try: () => new Entry(SERVICE, key).setPassword(value),
        catch: (e) => new KeychainError({ message: `failed to set ${key}`, cause: e }),
      }),
    delete: (key) =>
      Effect.sync(() => {
        try {
          new Entry(SERVICE, key).deletePassword()
        } catch {
          /* already absent */
        }
      }),
  })
}
