import { describe, it, expect } from 'vitest'
import { capabilitiesFor } from './capabilities'

describe('capabilitiesFor (static cloud/claude-code map by family)', () => {
  it('claude → vision + tools', () => {
    expect(capabilitiesFor('claude-sonnet-4-6')).toEqual({
      vision: true,
      audio: false,
      tools: true,
      realtime: false,
    })
  })
  it('gpt-4o → vision + tools', () => {
    expect(capabilitiesFor('gpt-4o-mini').tools).toBe(true)
  })
  it('deepseek → tools, no vision', () => {
    expect(capabilitiesFor('deepseek-v4-flash')).toEqual({
      vision: false,
      audio: false,
      tools: true,
      realtime: false,
    })
  })
  it('unknown model → conservative all-false', () => {
    expect(capabilitiesFor('mystery-model')).toEqual({
      vision: false,
      audio: false,
      tools: false,
      realtime: false,
    })
  })
})
