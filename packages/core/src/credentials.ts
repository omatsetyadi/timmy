import { Entry } from '@napi-rs/keyring'
import type { CredentialStore } from 'timmy-sdk'

/**
 * OS keychain-backed credential store (macOS Keychain / Windows Credential
 * Manager / libsecret) via @napi-rs/keyring. All Timmy secrets live under one
 * service; the `key` (e.g. "server:auth_token", "model:deepseek:api_key") is
 * the account name. Never written to config files or the database.
 */
const SERVICE = 'timmy'

export class KeychainCredentialStore implements CredentialStore {
  async get(key: string): Promise<string | null> {
    try {
      return new Entry(SERVICE, key).getPassword()
    } catch {
      // not found (keyring throws) → treat as absent
      return null
    }
  }

  async set(key: string, value: string): Promise<void> {
    new Entry(SERVICE, key).setPassword(value)
  }

  async delete(key: string): Promise<void> {
    try {
      new Entry(SERVICE, key).deletePassword()
    } catch {
      // already absent → no-op
    }
  }
}
