import { expect, it } from 'vitest'
import { buildMessages } from './prompt'
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
