import { describe, expect, it } from 'vitest'
import { buildMessages, buildSystemPrompt } from './prompt'
import type { TimmyConfig } from '../config/config'

const cfg = {
  assistant: {
    name: 'Timmy',
    personality: 'Be Timmy.',
    language: { proactive: 'en', conversation: 'auto', supported: ['en', 'id'] },
  },
} as TimmyConfig

it('prepends system prompt + language mirror, then history, then user', () => {
  const msgs = buildMessages(
    cfg,
    [{ id: '1', thread_id: 't', role: 'user', content: 'prev', created_at: '' }],
    'now',
  )
  expect(msgs[0].role).toBe('system')
  expect(msgs[0].content).toContain('same language')
  expect(msgs.at(-1)).toEqual({ role: 'user', content: 'now' })
})

const cfgReasoning = {
  assistant: {
    name: 'Timmy',
    personality: 'You are Timmy.',
    language: { proactive: 'en', conversation: 'auto', supported: ['en'] },
  },
} as TimmyConfig

describe('buildSystemPrompt reasoning pool', () => {
  it('mentions askModel + targets when a pool is present', () => {
    const p = buildSystemPrompt(cfgReasoning, ['deepseek/deepseek-v4-flash', 'ollama/qwen3:32b'])
    expect(p).toMatch(/askModel/)
    expect(p).toMatch(/deepseek\/deepseek-v4-flash/)
  })
  it('omits the pool section when empty', () => {
    const p = buildSystemPrompt(cfgReasoning, [])
    expect(p).not.toMatch(/askModel/)
  })
})

it('always offers the direct runCommand path and routes by cost', () => {
  const p = buildSystemPrompt(cfg, [])
  expect(p).toMatch(/runCommand/)
  expect(p).toMatch(/cheapest|direct/i)
})

it('mentions askClaude as the agentic doer when claudeAvailable', () => {
  const p = buildSystemPrompt(cfg, [], true)
  expect(p).toMatch(/askClaude/)
  expect(p).toMatch(/its own tools/i)
})
it('omits askClaude when not available', () => {
  expect(buildSystemPrompt(cfg, [], false)).not.toMatch(/askClaude/)
})

describe('assistant identity (name is live, not hardcoded)', () => {
  it('leads with the configured name, not a baked-in "Timmy"', () => {
    const named = {
      assistant: {
        name: 'Jarvis',
        personality: 'Be helpful.',
        language: { proactive: 'en', conversation: 'auto', supported: ['en'] },
      },
    } as TimmyConfig
    const p = buildSystemPrompt(named, [])
    expect(p).toMatch(/^You are Jarvis\b/)
    expect(p).not.toContain('Timmy')
  })
})

describe('user profile (name + about + style)', () => {
  const withUser = (user: { name?: string; about?: string; style?: string }) =>
    ({
      assistant: {
        name: 'Timmy',
        personality: 'Be Timmy.',
        language: { proactive: 'en', conversation: 'auto', supported: ['en'] },
      },
      user,
    }) as TimmyConfig

  it('injects style as a response-behavior instruction before the tool guidance', () => {
    const p = buildSystemPrompt(withUser({ style: 'Be terse and roast me.' }), [])
    expect(p).toContain('Be terse and roast me.')
    expect(p.indexOf('Be terse and roast me.')).toBeLessThan(p.indexOf('runCommand'))
  })

  it('injects about as user grounding, after tool guidance and before the memory block', () => {
    const block = '## What you know about the user\n- person: Omat'
    const p = buildSystemPrompt(withUser({ about: 'Engineer at Jitera.' }), [], false, block)
    expect(p).toContain('Engineer at Jitera.')
    expect(p.indexOf('Engineer at Jitera.')).toBeGreaterThan(p.indexOf('runCommand'))
    expect(p.indexOf('Engineer at Jitera.')).toBeLessThan(p.indexOf('What you know about the user'))
  })

  it("weaves the user's name into the about block", () => {
    const p = buildSystemPrompt(withUser({ name: 'Omat', about: 'Engineer.' }), [])
    expect(p).toMatch(/About the user: Their name is Omat\. Engineer\./)
  })

  it('injects the name even when about is unset', () => {
    const p = buildSystemPrompt(withUser({ name: 'Omat' }), [])
    expect(p).toContain('Their name is Omat.')
  })

  it('omits the about block when user is unset or empty', () => {
    expect(buildSystemPrompt(withUser({}), [])).not.toContain('About the user')
    expect(buildSystemPrompt(cfg, [])).not.toContain('About the user')
  })
})

describe('recalled memory block', () => {
  const block = '## What you know about the user\n- person: Omat {role: founder}'
  it('appends the memory block to the system message when provided', () => {
    const msgs = buildMessages(cfg, [], 'hi', [], false, block)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('What you know about the user')
    expect(msgs[0].content).toContain('person: Omat')
  })
  it('omits the memory block when absent', () => {
    expect(buildSystemPrompt(cfg, [], false)).not.toContain('What you know about the user')
    expect(buildSystemPrompt(cfg, [], false, '')).not.toContain('What you know about the user')
  })
})
