import { describe, it, expect } from 'vitest'
import { Stream } from 'effect'
import { Platform } from 'timmy-sdk'
import { buildAskClaudeTool } from './ask-claude'
import type { StreamChunk } from '../llm/stream-chunk'

const ctx = {
  credentials: { get: async () => null },
  signal: new AbortController().signal,
  platform: Platform.MAC,
}

describe('buildAskClaudeTool', () => {
  it('is confirm-tier and named askClaude', () => {
    const tool = buildAskClaudeTool({
      available: () => Promise.resolve(true),
      run: () => Stream.empty,
    })
    expect(tool.riskLevel).toBe('confirm')
    expect(tool.name).toBe('askClaude')
  })

  it('runs the agentic engine and returns the collected result + actions', async () => {
    const tool = buildAskClaudeTool({
      available: () => Promise.resolve(true),
      run: () =>
        Stream.fromIterable<StreamChunk>([
          { type: 'tool_call', toolCall: { id: '1', name: 'Write', arguments: '{}' } },
          { type: 'content', content: 'created the DB' },
          { type: 'usage', promptTokens: 10, completionTokens: 5 },
          { type: 'finish', reason: 'stop' },
        ]),
    })
    const r = await tool.execute({ task: 'make a dev db' }, ctx)
    expect(r.ok).toBe(true)
    expect((r.data as { text: string }).text).toContain('created the DB')
    expect((r.data as { actions: string[] }).actions).toContain('Write')
  })

  it('unavailable CLI → ok:false with a clear hint', async () => {
    const tool = buildAskClaudeTool({
      available: () => Promise.resolve(false),
      run: () => Stream.empty,
    })
    const r = await tool.execute({ task: 'x' }, ctx)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Claude Code/)
  })
})
