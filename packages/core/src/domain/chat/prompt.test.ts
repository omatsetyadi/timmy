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

it('mentions askClaude as the agentic doer when claudeAvailable', () => {
  const p = buildSystemPrompt(cfg, [], true)
  expect(p).toMatch(/askClaude/)
  expect(p).toMatch(/its own tools/i)
})
it('omits askClaude when not available', () => {
  expect(buildSystemPrompt(cfg, [], false)).not.toMatch(/askClaude/)
})
