import { describe, it, expect } from 'vitest'
import { Stream } from 'effect'
import { Platform } from 'timmy-sdk'
import { parseTargetId, buildAskModelTool } from './model-router'
import type { ProviderTarget } from '../llm/provider'
import type { StreamChunk } from '../llm/stream-chunk'

describe('parseTargetId', () => {
  it('splits on the first slash (model may contain colons)', () => {
    expect(parseTargetId('ollama/qwen3:32b')).toEqual({ providerKey: 'ollama', model: 'qwen3:32b' })
    expect(parseTargetId('deepseek/deepseek-v4-flash')).toEqual({
      providerKey: 'deepseek',
      model: 'deepseek-v4-flash',
    })
  })
  it('returns null for a bare id with no slash', () => {
    expect(parseTargetId('deepseek')).toBeNull()
  })
})

describe('buildAskModelTool', () => {
  const deps = {
    resolveTarget: (id: string): ProviderTarget | null =>
      id === 'deepseek/deepseek-v4-flash'
        ? {
            providerKey: 'deepseek',
            kind: 'openai-compat',
            model: 'deepseek-v4-flash',
            baseUrl: 'x',
          }
        : null,
    getKey: () => Promise.resolve('k'),
    runChat: () =>
      Stream.fromIterable<StreamChunk>([
        { type: 'content', content: 'the ' },
        { type: 'content', content: 'answer' },
        { type: 'usage', promptTokens: 5, completionTokens: 2 },
        { type: 'finish', reason: 'stop' },
      ]),
    defaultTargetId: () => 'deepseek/deepseek-v4-flash',
    poolIds: () => ['deepseek/deepseek-v4-flash'],
  }

  it('routes to an explicit target and returns the collected text + usage', async () => {
    const tool = buildAskModelTool(deps)
    const r = await tool.execute(
      { target: 'deepseek/deepseek-v4-flash', prompt: 'q' },
      {
        credentials: { get: async () => null },
        signal: new AbortController().signal,
        platform: Platform.MAC,
      },
    )
    expect(r.ok).toBe(true)
    expect(r.data).toEqual({
      text: 'the answer',
      usage: { promptTokens: 5, completionTokens: 2 },
      target: 'deepseek/deepseek-v4-flash',
    })
  })

  it('falls back to the default target when none given', async () => {
    const tool = buildAskModelTool(deps)
    const r = await tool.execute(
      { prompt: 'q' },
      {
        credentials: { get: async () => null },
        signal: new AbortController().signal,
        platform: Platform.MAC,
      },
    )
    expect(r.ok).toBe(true)
  })

  it('unknown target → ok:false with a set-key hint', async () => {
    const tool = buildAskModelTool(deps)
    const r = await tool.execute(
      { target: 'mystery/x', prompt: 'q' },
      {
        credentials: { get: async () => null },
        signal: new AbortController().signal,
        platform: Platform.MAC,
      },
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not configured/)
  })

  it('is safe-tier and advertises pool targets in its description', () => {
    const tool = buildAskModelTool(deps)
    expect(tool.riskLevel).toBe('safe')
    expect(tool.name).toBe('askModel')
    expect(tool.description).toMatch(/deepseek\/deepseek-v4-flash/)
  })
})
