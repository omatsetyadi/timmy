import { describe, it, expect } from 'vitest'
import { decodePlugin } from './plugin-schema'

const base = (over: object): unknown => ({
  apiVersion: 1,
  name: 'good',
  version: '1',
  tools: [
    {
      name: 'noop',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      riskLevel: 'safe',
      execute: () => {},
    },
  ],
  ...over,
})
const ok = (x: unknown): boolean => decodePlugin(x)._tag === 'Right'

describe('PluginSchema v1', () => {
  it('accepts a valid v1 plugin', () => {
    expect(ok(base({}))).toBe(true)
  })

  it('accepts a kebab-case plugin name', () => {
    expect(ok(base({ name: 'omat-workflow' }))).toBe(true)
  })

  it('rejects a non-kebab plugin name', () => {
    expect(ok(base({ name: 'My.Plugin' }))).toBe(false)
    expect(ok(base({ name: 'Bad Name' }))).toBe(false)
    expect(ok(base({ name: 'UPPER' }))).toBe(false)
    expect(ok(base({ name: 'a:b' }))).toBe(false)
  })

  it('rejects a tool name containing the namespace separator __', () => {
    expect(
      ok(
        base({
          tools: [
            {
              name: 'a__b',
              description: 'd',
              parameters: { type: 'object', properties: {} },
              riskLevel: 'safe',
              execute: () => {},
            },
          ],
        }),
      ),
    ).toBe(false)
  })

  it('rejects a tool name with provider-illegal characters', () => {
    expect(
      ok(
        base({
          tools: [
            {
              name: 'play.media',
              description: 'd',
              parameters: { type: 'object', properties: {} },
              riskLevel: 'safe',
              execute: () => {},
            },
          ],
        }),
      ),
    ).toBe(false)
  })
})
