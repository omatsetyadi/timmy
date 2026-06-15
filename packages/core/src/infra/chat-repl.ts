import { Effect, ManagedRuntime } from 'effect'
import { createInterface } from 'node:readline'
import { readConfigSync, type TimmyConfig } from '../domain/config/config'
import { CredentialStore } from '../domain/credentials/credential-store'
import type { StreamChunk } from '../domain/llm/stream-chunk'

// ── pure: NDJSON line → frame ───────────────────────────────────────────────
// The /chat stream is newline-delimited JSON: an opening {thread_id} line, then
// typed StreamChunk lines as tokens arrive, a possible {type:'confirm_required'}
// mid-stream, and a closing {done:true}. parseFrame classifies one raw line so
// the REPL shell can stay tiny and the classification stays unit-testable.

export type ChatFrame =
  | { kind: 'thread'; threadId: string }
  | { kind: 'done' }
  | { kind: 'confirm'; id: string; tool: string; description: string }
  | { kind: 'chunk'; chunk: StreamChunk }
  | { kind: 'ignore' }

export function parseFrame(line: string): ChatFrame {
  const trimmed = line.trim()
  if (trimmed === '') return { kind: 'ignore' }
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return { kind: 'ignore' }
  }
  if (typeof obj.thread_id === 'string') return { kind: 'thread', threadId: obj.thread_id }
  if (obj.done === true) return { kind: 'done' }
  if (obj.type === 'confirm_required') {
    return {
      kind: 'confirm',
      id: String(obj.id),
      tool: String(obj.tool),
      description: String(obj.description),
    }
  }
  if (typeof obj.type === 'string') return { kind: 'chunk', chunk: obj as unknown as StreamChunk }
  return { kind: 'ignore' }
}

// ── pure: StreamChunk → terminal output ─────────────────────────────────────
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`

export interface RenderOpts {
  showThinking?: boolean
}

/** Map ONE StreamChunk to the string to write to stdout. '' = render nothing.
 *  `confirm_required` is handled interactively by the shell, never here. */
export function renderChunk(chunk: StreamChunk, opts: RenderOpts = {}): string {
  switch (chunk.type) {
    case 'content':
      return chunk.content
    case 'thinking':
      return opts.showThinking ? dim(chunk.content) : ''
    case 'tool_call':
      return cyan(`\n→ ${chunk.toolCall.name}\n`)
    case 'usage':
      return dim(`\n[tokens: ${chunk.promptTokens}+${chunk.completionTokens}]`)
    case 'error':
      return red(`\n✗ ${chunk.message}\n`)
    case 'finish':
    case 'confirm_required':
      return ''
  }
}

// ── impure: the REPL shell ──────────────────────────────────────────────────
const AUTH_TOKEN_KEY = 'server:auth_token'

interface Daemon {
  base: string
  headers: Record<string, string>
}

/** Resolve the daemon base URL + auth header from config. A `keychain` token is
 *  read via a throwaway CredentialStore runtime (no DB/plugins, unlike the full
 *  server runtime); loopback with no token needs no header (server allows it). */
async function resolveDaemon(config: TimmyConfig): Promise<Daemon> {
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

/** `timmy chat [--thread <id>]` — interactive terminal chat against the running
 *  daemon. The CLI is a thin HTTP client; `timmy start` runs the daemon. */
export async function runChat(opts: { threadArg?: string } = {}): Promise<void> {
  const config = readConfigSync()
  const daemon = await resolveDaemon(config)

  // Preflight: a clear "start the daemon" message beats a raw ECONNREFUSED.
  try {
    await fetch(`${daemon.base}/health`)
  } catch {
    console.error("Timmy isn't running — start it with `timmy start`.")
    process.exit(1)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve))

  let threadId = opts.threadArg
  let showThinking = false

  process.stdout.write(
    dim('Timmy chat — type a message · /think toggles reasoning · /exit (or Ctrl-C) quits\n\n'),
  )

  // Ctrl-C closes the readline; the loop sees it and exits cleanly.
  let interrupted = false
  rl.on('SIGINT', () => {
    interrupted = true
    rl.close()
  })

  while (!interrupted) {
    const message = await ask('you › ').catch(() => null)
    if (message === null) break // readline closed (EOF / SIGINT)
    const text = message.trim()
    if (text === '') continue
    if (text === '/exit' || text === '/quit') break
    if (text === '/think') {
      showThinking = !showThinking
      process.stdout.write(dim(`thinking ${showThinking ? 'shown' : 'hidden'}\n`))
      continue
    }

    process.stdout.write('timmy › ')
    try {
      threadId = await streamTurn(daemon, text, threadId, { showThinking }, ask)
    } catch (e) {
      process.stdout.write(red(`\n✗ ${e instanceof Error ? e.message : String(e)}\n`))
    }
    process.stdout.write('\n')
  }

  rl.close()
  if (interrupted) process.stdout.write('\n')
}

/** POST one message, stream the NDJSON reply, render live, and handle an inline
 *  confirm. Returns the (possibly newly assigned) thread id to reuse next turn. */
async function streamTurn(
  daemon: Daemon,
  message: string,
  threadId: string | undefined,
  render: RenderOpts,
  ask: (q: string) => Promise<string>,
): Promise<string | undefined> {
  const res = await fetch(`${daemon.base}/chat`, {
    method: 'POST',
    headers: daemon.headers,
    body: JSON.stringify({ message, thread_id: threadId }),
  })
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw new Error(`chat failed (${res.status})${body ? `: ${body}` : ''}`)
  }

  let currentThread = threadId
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
      const frame = parseFrame(line)
      switch (frame.kind) {
        case 'thread':
          currentThread = frame.threadId
          break
        case 'confirm':
          // The daemon's stream is blocked on a Deferred until /confirm resolves;
          // prompt y/N inline, POST the answer, then resume reading.
          await handleConfirm(daemon, frame, ask)
          break
        case 'chunk':
          process.stdout.write(renderChunk(frame.chunk, render))
          break
        case 'done':
        case 'ignore':
          break
      }
    }
  }
  return currentThread
}

async function handleConfirm(
  daemon: Daemon,
  frame: { id: string; tool: string; description: string },
  ask: (q: string) => Promise<string>,
): Promise<void> {
  const answer = await ask(
    `\n\x1b[33m⚠\x1b[0m ${frame.tool} wants to: ${frame.description}\n  approve? (y/N) `,
  )
  const allowed = answer.trim().toLowerCase() === 'y'
  await fetch(`${daemon.base}/confirm/${frame.id}`, {
    method: 'POST',
    headers: daemon.headers,
    body: JSON.stringify({ allowed }),
  }).catch(() => {})
  process.stdout.write(dim(allowed ? '  approved\n' : '  declined\n'))
}
