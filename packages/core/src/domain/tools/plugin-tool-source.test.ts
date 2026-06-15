import { describe, it, expect } from 'vitest'
import { Platform, type TimmyPlugin } from 'timmy-sdk'
import { buildPluginToolSource } from './plugin-tool-source'

const mk = (name: string, toolName: string, keys: string[] = []): TimmyPlugin => ({
  apiVersion: 1,
  name,
  version: '1',
  credentials: keys.map((k) => ({ key: k, label: k, type: 'secret' as const })),
  tools: [
    {
      name: toolName,
      description: 'd',
      parameters: { type: 'object', properties: {} },
      riskLevel: 'safe',
      execute: async () => ({ ok: true }),
    },
  ],
})

describe('buildPluginToolSource', () => {
  it('namespaces tools as <plugin>__<tool>', () => {
    const { tools } = buildPluginToolSource([mk('machine', 'playMedia')])
    expect(tools.map((t) => t.name)).toEqual(['machine__playMedia'])
  })

  it('keys the credential scope by the namespaced name', () => {
    const { credentialScopeByTool } = buildPluginToolSource([mk('slack', 'send', ['token'])])
    expect(credentialScopeByTool.get('slack__send')).toEqual({ plugin: 'slack', keys: ['token'] })
  })

  it('preserves the original tool behavior (execute) under the new name', async () => {
    const { tools } = buildPluginToolSource([mk('machine', 'playMedia')])
    const ctx = {
      credentials: { get: async () => null },
      signal: new AbortController().signal,
      platform: Platform.MAC,
    }
    expect(await tools[0]!.execute({}, ctx)).toEqual({ ok: true })
  })

  it('drops (with no throw) a tool whose composite name exceeds 64 chars', () => {
    const { tools } = buildPluginToolSource([mk('plugin', 'x'.repeat(60))])
    expect(tools).toEqual([])
  })
})
