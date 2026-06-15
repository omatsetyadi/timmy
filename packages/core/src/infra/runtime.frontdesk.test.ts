import { describe, it, expect } from 'vitest'
import { frontdeskTarget } from './runtime'
import type { TimmyConfig } from '../domain/config/config'

const cfg = (
  frontdesk: { provider: string; model: string },
  providers?: TimmyConfig['providers'],
) => ({ models: { frontdesk }, providers }) as unknown as TimmyConfig

describe('frontdeskTarget kind resolution', () => {
  it('ollama frontdesk → ollama (implicit local default)', () => {
    expect(frontdeskTarget(cfg({ provider: 'ollama', model: 'qwen3.6:27b' })).kind).toBe('ollama')
  })

  it('a known cloud provider (deepseek) with NO providers entry → openai-compat, NOT ollama', () => {
    // the bug: this used to fall back to ollama and hit localhost
    expect(frontdeskTarget(cfg({ provider: 'deepseek', model: 'deepseek-v4-flash' })).kind).toBe(
      'openai-compat',
    )
  })

  it('openai → openai-compat even without an explicit providers entry', () => {
    expect(frontdeskTarget(cfg({ provider: 'openai', model: 'gpt-5.5-pro' })).kind).toBe(
      'openai-compat',
    )
  })

  it('a declared provider uses its configured kind', () => {
    const t = frontdeskTarget(
      cfg(
        { provider: 'mycloud', model: 'x' },
        { mycloud: { kind: 'openai-compat', base_url: 'http://h' } },
      ),
    )
    expect(t.kind).toBe('openai-compat')
    expect(t.baseUrl).toBe('http://h')
  })

  it('an unknown provider with no entry → ollama (local default)', () => {
    expect(frontdeskTarget(cfg({ provider: 'weird', model: 'x' })).kind).toBe('ollama')
  })
})
