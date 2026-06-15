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

  it('routes runCommand through the command classifier', () => {
    expect(
      resolvePermission({
        toolName: 'runCommand',
        riskLevel: 'confirm',
        args: { command: 'ls -la' },
        config: cfg(),
      }),
    ).toBe('allow')
    expect(
      resolvePermission({
        toolName: 'runCommand',
        riskLevel: 'confirm',
        args: { command: 'rm -rf /' },
        config: cfg(),
      }),
    ).toBe('ask')
    expect(
      resolvePermission({
        toolName: 'runCommand',
        riskLevel: 'confirm',
        args: { command: 'npm install x' },
        config: cfg({ commands: { allow: ['npm install'] } }),
      }),
    ).toBe('allow')
  })

  it('an explicit runCommand=allow override beats the classifier', () => {
    expect(
      resolvePermission({
        toolName: 'runCommand',
        riskLevel: 'confirm',
        args: { command: 'rm -rf /' },
        config: cfg({ tools: { runCommand: 'allow' } }),
      }),
    ).toBe('allow')
  })
})
