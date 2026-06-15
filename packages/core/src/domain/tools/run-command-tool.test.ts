import { describe, it, expect } from 'vitest'
import { Platform } from 'timmy-sdk'
import {
  buildRunCommandTool,
  capOutput,
  MAX_COMMAND_OUTPUT,
  type CommandRunner,
} from './run-command-tool'
import { RUN_COMMAND } from './command-risk'

const ctx = {
  credentials: { get: async () => null },
  signal: new AbortController().signal,
  platform: Platform.MAC,
}

describe('runCommand tool', () => {
  it('is named runCommand with a confirm baseline tier', () => {
    const t = buildRunCommandTool()
    expect(t.name).toBe(RUN_COMMAND)
    expect(t.riskLevel).toBe('confirm')
  })

  it('returns ok:true with stdout/stderr/code on a zero exit', async () => {
    const run: CommandRunner = async () => ({ stdout: 'hi\n', stderr: '', code: 0 })
    const r = await buildRunCommandTool(run).execute({ command: 'echo hi' }, ctx)
    expect(r).toEqual({ ok: true, data: { stdout: 'hi\n', stderr: '', code: 0 } })
  })

  it('returns ok:false with the error on a non-zero exit', async () => {
    const run: CommandRunner = async () => ({ stdout: '', stderr: 'nope', code: 1 })
    const r = await buildRunCommandTool(run).execute({ command: 'false' }, ctx)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('nope')
    expect(r.data).toEqual({ stdout: '', stderr: 'nope', code: 1 })
  })

  it('rejects an empty command', async () => {
    const r = await buildRunCommandTool(async () => ({ stdout: '', stderr: '', code: 0 })).execute(
      { command: '  ' },
      ctx,
    )
    expect(r.ok).toBe(false)
  })

  it('forwards cwd and the abort signal to the runner', async () => {
    let seen: { cwd?: string; signal?: AbortSignal } | undefined
    const run: CommandRunner = async (_cmd, opts) => {
      seen = opts
      return { stdout: '', stderr: '', code: 0 }
    }
    await buildRunCommandTool(run).execute({ command: 'ls', cwd: '/tmp' }, ctx)
    expect(seen?.cwd).toBe('/tmp')
    expect(seen?.signal).toBe(ctx.signal)
  })
})

describe('capOutput', () => {
  it('passes output through under the cap', () => {
    expect(capOutput('', 'hello', 100)).toBe('hello')
    expect(capOutput('ab', 'cd', 100)).toBe('abcd')
  })

  it('truncates with a marker once the cap is hit', () => {
    const r = capOutput('', 'x'.repeat(500), 100)
    expect(r.length).toBeLessThan(200)
    expect(r).toContain('[truncated]')
  })

  it('stops appending after the cap is reached', () => {
    const full = capOutput('', 'x'.repeat(500), 100)
    expect(capOutput(full, 'more', 100)).toBe(full)
  })
})

describe('runCommand default runner', () => {
  it('caps a chatty command so it cannot flood the model context', async () => {
    const r = await buildRunCommandTool().execute(
      { command: `node -e "process.stdout.write('x'.repeat(100000))"` },
      ctx,
    )
    expect(r.ok).toBe(true)
    const data = r.data as { stdout: string }
    expect(data.stdout.length).toBeLessThan(MAX_COMMAND_OUTPUT + 100)
    expect(data.stdout).toContain('[truncated]')
  })

  it('closes stdin so a stdin-reading command exits instead of hanging', async () => {
    // `cat` with no args reads stdin forever unless it gets EOF (stdin closed).
    const r = await buildRunCommandTool().execute({ command: 'cat' }, ctx)
    expect((r.data as { code: number }).code).toBe(0)
  })
})
