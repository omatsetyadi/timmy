import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'

/** Shape of ~/.timmy/config.yaml (Phase 1 subset — grows in later phases). */
export interface TimmyConfig {
  server: {
    host: string
    port: number
    auth: {
      enabled: boolean
      /** 'keychain' means the token is read from the OS keychain, not the file. */
      token: 'keychain' | string
    }
  }
}

export const CONFIG_DIR = join(homedir(), '.timmy')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml')

const DEFAULT_CONFIG: TimmyConfig = {
  server: {
    host: '127.0.0.1',
    port: 3737,
    auth: {
      enabled: true,
      token: 'keychain',
    },
  },
}

/**
 * Load and merge config from ~/.timmy/config.yaml over the defaults.
 * Missing file → defaults. Shallow-merges the `server` block so a partial
 * config file still gets sane defaults for unspecified keys.
 */
export function loadConfig(path: string = CONFIG_PATH): TimmyConfig {
  if (!existsSync(path)) {
    return DEFAULT_CONFIG
  }

  const raw = load(readFileSync(path, 'utf8'))
  if (raw === null || typeof raw !== 'object') {
    return DEFAULT_CONFIG
  }

  const file = raw as Partial<TimmyConfig>
  return {
    server: {
      ...DEFAULT_CONFIG.server,
      ...file.server,
      auth: {
        ...DEFAULT_CONFIG.server.auth,
        ...file.server?.auth,
      },
    },
  }
}
