import { describe, it, expect } from 'vitest'
import { resolveBaseUrl, KNOWN_BASE_URLS } from './known-providers'

describe('resolveBaseUrl', () => {
  it('falls back to the known URL when base_url is omitted', () => {
    expect(resolveBaseUrl('deepseek')).toBe('https://api.deepseek.com')
    expect(resolveBaseUrl('openai')).toBe(KNOWN_BASE_URLS.openai)
  })
  it('a configured base_url always wins (override / self-hosted / proxy)', () => {
    expect(resolveBaseUrl('deepseek', 'http://localhost:8080')).toBe('http://localhost:8080')
  })
  it('unknown provider with no base_url → undefined (e.g. ollama uses its own default)', () => {
    expect(resolveBaseUrl('ollama')).toBeUndefined()
  })
})
