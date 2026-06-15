import { describe, it, expect } from 'vitest'
import { applyMode, applyOverride, applyAllowedCommand, commandSignature } from './permission-cli'

describe('permission config transforms (pure)', () => {
  it('applyMode sets permissions.mode', () => {
    expect(applyMode({}, 'yolo')).toEqual({ permissions: { mode: 'yolo' } })
  })

  it('applyOverride sets a tool or plugin override', () => {
    expect(applyOverride({}, 'tool', 'runCommand', 'allow')).toEqual({
      permissions: { tools: { runCommand: 'allow' } },
    })
    expect(applyOverride({}, 'plugin', 'machine', 'block')).toEqual({
      permissions: { plugins: { machine: 'block' } },
    })
  })

  it('applyAllowedCommand appends and de-duplicates', () => {
    const a = applyAllowedCommand({}, 'npm install')
    expect(a).toEqual({ permissions: { commands: { allow: ['npm install'] } } })
    expect(applyAllowedCommand(a, 'npm install')).toEqual(a)
  })

  it('preserves unrelated config', () => {
    const raw = { models: { frontdesk: { provider: 'ollama', model: 'x' } } }
    expect(applyMode(raw, 'yolo').models).toEqual(raw.models)
  })
})

describe('commandSignature', () => {
  it('keeps program + bare subcommand, drops flags/args', () => {
    expect(commandSignature('npm install lodash')).toBe('npm install')
    expect(commandSignature('git commit -m "x"')).toBe('git commit')
    expect(commandSignature('ls -la')).toBe('ls')
    expect(commandSignature('python script.py')).toBe('python')
    expect(commandSignature('docker ps')).toBe('docker ps')
  })
})
