import { spawn } from 'node:child_process'
import type { Tool, ToolResult } from 'timmy-sdk'
import { RUN_COMMAND } from './command-risk'

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

/** Injectable so the tool is unit-testable without spawning a real shell. */
export type CommandRunner = (
  command: string,
  opts: { cwd?: string; signal?: AbortSignal },
) => Promise<CommandResult>

/** Cap accumulated command output so a chatty command can't flood the model's context (the tool
 *  result is sent back to the LLM). Appends a marker once the limit is hit, then stops growing. */
export const MAX_COMMAND_OUTPUT = 16 * 1024
export function capOutput(current: string, chunk: string, max = MAX_COMMAND_OUTPUT): string {
  if (current.length >= max) return current
  const room = max - current.length
  return chunk.length <= room ? current + chunk : current + chunk.slice(0, room) + '\n…[truncated]'
}

const defaultRunner: CommandRunner = (command, opts) =>
  new Promise<CommandResult>((resolve, reject) => {
    // shell:true runs via the OS shell (sh -c / cmd /c) — required because the tool's whole
    // purpose is to run real shell commands (pipes, etc.) the user approves. The security
    // boundary is the permission layer, NOT this spawn: a command only reaches here when it
    // resolved to `allow`, and classifyCommand auto-allows ONLY metacharacter-free `program
    // args` strings (see SHELL_METACHARS). Anything with shell power (`;`, `|`, `$()`, `>`, …)
    // resolves to `ask`, so shell:true's capability is only ever exercised on a human-approved
    // command. (A filesystem/network sandbox is a deliberate non-goal here — see the spec; a
    // future hardening if Timmy ever runs untrusted.)
    // stdin closed ('ignore') so an interactive command (a prompt/pager) gets EOF and exits
    // instead of hanging forever; output is capped so a chatty command can't flood the context.
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      signal: opts.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => (stdout = capOutput(stdout, d.toString())))
    child.stderr?.on('data', (d: Buffer) => (stderr = capOutput(stderr, d.toString())))
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }))
  })

/** The core terminal tool: run a shell command on the host. Its permission is decided
 *  per-command by the classifier + resolver (see {@link classifyCommand}); the static
 *  `confirm` tier here is only the baseline before that dynamic resolution. */
export function buildRunCommandTool(run: CommandRunner = defaultRunner): Tool {
  return {
    name: RUN_COMMAND,
    description:
      'Run a shell command on the host machine and return its stdout, stderr, and exit code. Use for quick OS/dev tasks — checking status, listing, git, docker. Dangerous commands require user confirmation.',
    riskLevel: 'confirm',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'the shell command to run' },
        cwd: { type: 'string', description: 'working directory (optional)' },
      },
      required: ['command'],
    },
    execute: async (args, ctx): Promise<ToolResult> => {
      const command = String(args.command ?? '').trim()
      if (!command) return { ok: false, error: 'command is required' }
      try {
        const { stdout, stderr, code } = await run(command, {
          cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
          signal: ctx.signal,
        })
        const data = { stdout, stderr, code }
        return code === 0
          ? { ok: true, data }
          : { ok: false, data, error: stderr || `exited ${code}` }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}
