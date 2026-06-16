import { describe, expect, it } from 'vitest'
import { isRiskLevel, Platform, PLUGIN_API_VERSION } from './index'
import type { TimmyPlugin, Tool, ToolContext } from './index'

it('isRiskLevel recognizes the three tiers', () => {
  expect(isRiskLevel('safe')).toBe(true)
  expect(isRiskLevel('confirm')).toBe(true)
  expect(isRiskLevel('blocked')).toBe(true)
  expect(isRiskLevel('nope')).toBe(false)
})

it('PLUGIN_API_VERSION is 1', () => {
  expect(PLUGIN_API_VERSION).toBe(1)
})

it('a v1 plugin + a ctx carrying platform typecheck and round-trip', () => {
  const ctx: ToolContext = {
    credentials: { get: async () => null },
    signal: new AbortController().signal,
    platform: Platform.MAC,
  }
  const plugin: TimmyPlugin = {
    apiVersion: PLUGIN_API_VERSION,
    name: 'sample',
    version: '0.0.0',
    tools: [],
  }
  expect(ctx.platform).toBe(Platform.MAC)
  expect(plugin.apiVersion).toBe(1)
})

describe('Tool.allowSignature', () => {
  it('is optional and returns a signature string or null', () => {
    const withSig: Tool = {
      name: 'runCommand',
      description: 'run a shell command',
      parameters: {},
      riskLevel: 'confirm',
      allowSignature: (args) => {
        const cmd = String(args.command ?? '')
        return cmd ? cmd.split(/\s+/).slice(0, 2).join(' ') : null
      },
      execute: async () => ({ ok: true }),
    }
    const without: Tool = {
      name: 'askVision',
      description: 'see an image',
      parameters: {},
      riskLevel: 'safe',
      execute: async () => ({ ok: true }),
    }
    expect(withSig.allowSignature!({ command: 'git commit -m x' })).toBe('git commit')
    expect(withSig.allowSignature!({ command: '' })).toBeNull()
    expect(without.allowSignature).toBeUndefined()
  })
})
