import { describe, it, expect } from 'vitest'
import { claudeMessageToChunk } from './claude-code-provider'

describe('claudeMessageToChunk (Agent SDK message → StreamChunk)', () => {
  it('maps thinking / tool_use / text / result(usage)', () => {
    expect(
      claudeMessageToChunk({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
      }),
    ).toEqual({ type: 'thinking', content: 'hmm' })
    expect(
      claudeMessageToChunk({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Write', input: { p: 1 } }] },
      }),
    ).toEqual({ type: 'tool_call', toolCall: { id: 'tu1', name: 'Write', arguments: '{"p":1}' } })
    expect(
      claudeMessageToChunk({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Done' }] },
      }),
    ).toEqual({ type: 'content', content: 'Done' })
    expect(
      claudeMessageToChunk({ type: 'result', usage: { input_tokens: 120, output_tokens: 40 } }),
    ).toEqual({ type: 'usage', promptTokens: 120, completionTokens: 40 })
  })

  it('returns null for an unrecognized message', () => {
    expect(claudeMessageToChunk({ type: 'system' })).toBeNull()
  })
})
