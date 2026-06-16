import { Effect, ManagedRuntime } from 'effect'
import { type TimmyConfig } from '../../domain/config/config'
import { CredentialStore } from '../../domain/credentials/credential-store'
import { parseFrame, type ChatFrame } from './frames'

// ── shared HTTP client for the Ink TUI (no Ink import — safe in tsc-CJS + tsup ESM) ──
const AUTH_TOKEN_KEY = 'server:auth_token'

export interface Daemon {
  base: string
  headers: Record<string, string>
}

/** Resolve the daemon base URL + auth header from config. A `keychain` token is
 *  read via a throwaway CredentialStore runtime (no DB/plugins, unlike the full
 *  server runtime); loopback with no token needs no header (server allows it). */
export async function resolveDaemon(config: TimmyConfig): Promise<Daemon> {
  const host = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host
  const base = `http://${host}:${config.server.port}`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.server.auth.enabled) {
    let token = config.server.auth.token
    if (token === 'keychain') {
      const rt = ManagedRuntime.make(CredentialStore.Live)
      token =
        (await rt.runPromise(CredentialStore.pipe(Effect.flatMap((c) => c.get(AUTH_TOKEN_KEY))))) ??
        ''
      await rt.dispose()
    }
    if (token) headers.authorization = `Bearer ${token}`
  }
  return { base, headers }
}

export async function* streamChat(
  daemon: Daemon,
  message: string,
  threadId: string | undefined,
  signal?: AbortSignal,
): AsyncGenerator<ChatFrame> {
  // `signal` aborts the fetch → closes the request → the server interrupts its streaming fiber
  // (Effect Fiber.interrupt on req close), stopping the model + any in-flight tools.
  const res = await fetch(`${daemon.base}/chat`, {
    method: 'POST',
    headers: daemon.headers,
    body: JSON.stringify({ message, thread_id: threadId }),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`chat failed (${res.status})`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      yield parseFrame(line)
    }
  }
}

export async function sendConfirm(
  daemon: Daemon,
  id: string,
  decision: 'once' | 'always' | 'deny',
): Promise<void> {
  await fetch(`${daemon.base}/confirm/${id}`, {
    method: 'POST',
    headers: daemon.headers,
    body: JSON.stringify({ decision }),
  }).catch(() => {})
}

export interface EffectivePermissions {
  mode: string
  tools?: Record<string, string>
  commands?: { allow?: string[] }
}

export async function getPermissions(daemon: Daemon): Promise<EffectivePermissions> {
  const res = await fetch(`${daemon.base}/permissions`, { headers: daemon.headers })
  return res.json() as Promise<EffectivePermissions>
}

export async function postPermissions(
  daemon: Daemon,
  body:
    | { mode: 'default' | 'yolo' }
    | { kind: 'tool' | 'plugin'; name: string; perm: 'allow' | 'ask' | 'block' },
): Promise<void> {
  await fetch(`${daemon.base}/permissions`, {
    method: 'POST',
    headers: daemon.headers,
    body: JSON.stringify(body),
  }).catch(() => {})
}
