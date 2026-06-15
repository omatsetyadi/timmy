import { describe, it, expect } from 'vitest'
import type { PermissionConfig } from '../config/config'
import { resolvePermission } from './permission-resolver'

const cfg = (over: Partial<PermissionConfig> = {}): PermissionConfig => ({
  mode: 'default',
  ...over,
})

describe('resolvePermission', () => {
  it('blocks a tool declared blocked, or overridden to block (even under yolo)', () => {
    expect(
      resolvePermission({ toolName: 't', riskLevel: 'blocked', args: {}, config: cfg() }),
    ).toBe('block')
    expect(
      resolvePermission({
        toolName: 't',
        riskLevel: 'safe',
        args: {},
        config: cfg({ tools: { t: 'block' } }),
      }),
    ).toBe('block')
    expect(
      resolvePermission({
        toolName: 't',
        riskLevel: 'safe',
        args: {},
        config: cfg({ mode: 'yolo', tools: { t: 'block' } }),
      }),
    ).toBe('block')
  })

  it('blocks via a plugin-level override', () => {
    expect(
      resolvePermission({
        toolName: 'machine__x',
        riskLevel: 'safe',
        args: {},
        plugin: 'machine',
        config: cfg({ plugins: { machine: 'block' } }),
      }),
    ).toBe('block')
  })

  it('honors an explicit allow/ask override (tool beats plugin)', () => {
    expect(
      resolvePermission({
        toolName: 't',
        riskLevel: 'confirm',
        args: {},
        config: cfg({ tools: { t: 'allow' } }),
      }),
    ).toBe('allow')
    expect(
      resolvePermission({
        toolName: 'machine__x',
        riskLevel: 'safe',
        args: {},
        plugin: 'machine',
        config: cfg({ plugins: { machine: 'ask' }, tools: { machine__x: 'allow' } }),
      }),
    ).toBe('allow')
  })

  it('yolo auto-allows a confirm-tier tool', () => {
    expect(
      resolvePermission({
        toolName: 't',
        riskLevel: 'confirm',
        args: {},
        config: cfg({ mode: 'yolo' }),
      }),
    ).toBe('allow')
  })

  it('default mode falls through to the declared tier', () => {
    expect(resolvePermission({ toolName: 't', riskLevel: 'safe', args: {}, config: cfg() })).toBe(
      'allow',
    )
    expect(
      resolvePermission({ toolName: 't', riskLevel: 'confirm', args: {}, config: cfg() }),
    ).toBe('ask')
  })

  // --- dynamic risk-classifier hook (SDK Tool.classify) — the plugin path -----------------

  it('uses a tool-provided classify hook instead of the static tier', () => {
    const allowAll = () => 'allow' as const
    const askAll = () => 'ask' as const
    expect(
      resolvePermission({
        toolName: 't',
        riskLevel: 'confirm',
        args: {},
        config: cfg(),
        classify: allowAll,
      }),
    ).toBe('allow')
    expect(
      resolvePermission({
        toolName: 't',
        riskLevel: 'safe',
        args: {},
        config: cfg(),
        classify: askAll,
      }),
    ).toBe('ask')
  })

  it('passes the configured allowlist to the classify hook', () => {
    const classify = (args: Record<string, unknown>, ctx: { allowlist: readonly string[] }) =>
      ctx.allowlist.includes(String(args.cmd)) ? ('allow' as const) : ('ask' as const)
    expect(
      resolvePermission({
        toolName: 't',
        riskLevel: 'confirm',
        args: { cmd: 'foo' },
        config: cfg({ commands: { allow: ['foo'] } }),
        classify,
      }),
    ).toBe('allow')
    expect(
      resolvePermission({
        toolName: 't',
        riskLevel: 'confirm',
        args: { cmd: 'bar' },
        config: cfg({ commands: { allow: ['foo'] } }),
        classify,
      }),
    ).toBe('ask')
  })

  it('block / explicit-override / yolo still win over a classify hook', () => {
    const askAll = () => 'ask' as const
    const allowAll = () => 'allow' as const
    // explicit allow override beats classify(ask)
    expect(
      resolvePermission({
        toolName: 't',
        riskLevel: 'confirm',
        args: {},
        config: cfg({ tools: { t: 'allow' } }),
        classify: askAll,
      }),
    ).toBe('allow')
    // yolo beats classify(ask)
    expect(
      resolvePermission({
        toolName: 't',
        riskLevel: 'confirm',
        args: {},
        config: cfg({ mode: 'yolo' }),
        classify: askAll,
      }),
    ).toBe('allow')
    // block beats classify(allow)
    expect(
      resolvePermission({
        toolName: 't',
        riskLevel: 'confirm',
        args: {},
        config: cfg({ tools: { t: 'block' } }),
        classify: allowAll,
      }),
    ).toBe('block')
  })
})
