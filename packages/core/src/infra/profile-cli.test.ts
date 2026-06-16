import { describe, it, expect } from 'vitest'
import { applyProfileEdit, applyLanguageEdit, formatProfile, type Raw } from './profile-cli'

describe('applyProfileEdit (pure config mutation)', () => {
  it('sets an assistant field under assistant.*', () => {
    const out = applyProfileEdit({}, 'assistant', 'personality', 'Witty buddy.')
    expect((out.assistant as Raw).personality).toBe('Witty buddy.')
  })

  it('sets a user field under user.*, preserving siblings', () => {
    const start: Raw = { user: { style: 'terse' } }
    const out = applyProfileEdit(start, 'user', 'about', 'Engineer.')
    expect(out.user).toEqual({ style: 'terse', about: 'Engineer.' })
  })

  it('keeps the assistant and user sections independent', () => {
    let raw: Raw = {}
    raw = applyProfileEdit(raw, 'assistant', 'name', 'Timmy')
    raw = applyProfileEdit(raw, 'user', 'name', 'Omat')
    expect((raw.assistant as Raw).name).toBe('Timmy')
    expect((raw.user as Raw).name).toBe('Omat')
  })

  it('preserves unrelated top-level config (e.g. memory)', () => {
    const start: Raw = { memory: { learning_mode: true } }
    const out = applyProfileEdit(start, 'user', 'style', 'roast me')
    expect(out.memory).toEqual({ learning_mode: true })
  })

  it('clears a field when value is null (removes the key, drops the section if empty)', () => {
    const start: Raw = { user: { about: 'x' } }
    const out = applyProfileEdit(start, 'user', 'about', null)
    expect('user' in out).toBe(false)
  })

  it('clearing one field keeps the other in the same section', () => {
    const start: Raw = { user: { about: 'x', style: 'y' } }
    const out = applyProfileEdit(start, 'user', 'about', null)
    expect(out.user).toEqual({ style: 'y' })
  })
})

describe('applyLanguageEdit (nested assistant.language)', () => {
  it('sets a scalar language field under assistant.language', () => {
    const out = applyLanguageEdit({}, 'conversation', 'English')
    expect(((out.assistant as Raw).language as Raw).conversation).toBe('English')
  })

  it('sets supported as an array', () => {
    const out = applyLanguageEdit({}, 'supported', ['en', 'id', 'ja'])
    expect(((out.assistant as Raw).language as Raw).supported).toEqual(['en', 'id', 'ja'])
  })

  it('preserves other assistant fields (name/personality) when editing language', () => {
    const start: Raw = { assistant: { name: 'Timmy', personality: 'Witty.' } }
    const out = applyLanguageEdit(start, 'conversation', 'English')
    const assistant = out.assistant as Raw
    expect(assistant.name).toBe('Timmy')
    expect(assistant.personality).toBe('Witty.')
    expect((assistant.language as Raw).conversation).toBe('English')
  })

  it('clearing a language field removes it; empties drop language, then assistant', () => {
    const start: Raw = { assistant: { language: { conversation: 'English' } } }
    const out = applyLanguageEdit(start, 'conversation', null)
    expect('assistant' in out).toBe(false)
  })

  it('clearing one language field keeps the assistant section if name remains', () => {
    const start: Raw = { assistant: { name: 'Timmy', language: { conversation: 'English' } } }
    const out = applyLanguageEdit(start, 'conversation', null)
    expect((out.assistant as Raw).name).toBe('Timmy')
    expect('language' in (out.assistant as Raw)).toBe(false)
  })
})

describe('formatProfile', () => {
  it('renders both sections with labels, (unset) for missing fields', () => {
    const s = formatProfile(
      { name: 'Timmy', personality: 'Witty.' },
      { name: 'Omat', about: undefined, style: 'terse' },
    )
    expect(s).toMatch(/Assistant/i)
    expect(s).toContain('Timmy')
    expect(s).toContain('Witty.')
    expect(s).toMatch(/You|User/i)
    expect(s).toContain('Omat')
    expect(s).toContain('(unset)')
    expect(s).toContain('terse')
  })

  it('renders the language block when present', () => {
    const s = formatProfile(
      {
        name: 'Timmy',
        language: { conversation: 'auto', proactive: 'en', supported: ['en', 'id'] },
      },
      {},
    )
    expect(s).toMatch(/language/i)
    expect(s).toContain('conversation=auto')
    expect(s).toContain('proactive=en')
    expect(s).toContain('en, id')
  })
})
