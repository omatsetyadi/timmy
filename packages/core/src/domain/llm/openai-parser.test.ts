import { describe, it, expect } from 'vitest'
import { parseOpenAiData } from './openai-parser'
import { foldDelta, emptyFoldState } from './openai-parser'
import type { StreamChunk } from './stream-chunk'

describe('parseOpenAiData', () => {
  it('extracts content delta', () => {
    const d = parseOpenAiData(
      JSON.stringify({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }),
    )
    expect(d).toEqual({ content: 'Hi' })
  })
  it('extracts reasoning_content as thinking', () => {
    const d = parseOpenAiData(
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' } }] }),
    )
    expect(d).toEqual({ thinking: 'hmm' })
  })
  it('extracts a tool-call fragment with index', () => {
    const d = parseOpenAiData(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'c1', function: { name: 'askModel', arguments: '{"pro' } },
              ],
            },
          },
        ],
      }),
    )
    expect(d).toEqual({ toolCalls: [{ index: 0, id: 'c1', name: 'askModel', argsDelta: '{"pro' }] })
  })
  it('extracts finish_reason and usage', () => {
    const d = parseOpenAiData(
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }),
    )
    expect(d).toEqual({ finishReason: 'tool_calls', usage: { prompt: 10, completion: 3 } })
  })
  it("returns null for malformed JSON (degrade-don't-die)", () => {
    expect(parseOpenAiData('{ not json')).toBeNull()
  })
})

describe('foldDelta (streamed tool-call assembly)', () => {
  it('passes content + thinking + usage straight through', () => {
    let st = emptyFoldState()
    const out: StreamChunk[] = []
    for (const d of [
      { thinking: 'h' },
      { content: 'Hi' },
      { usage: { prompt: 2, completion: 1 } },
    ]) {
      const [s, chunks] = foldDelta(st, d)
      st = s
      out.push(...chunks)
    }
    expect(out).toEqual([
      { type: 'thinking', content: 'h' },
      { type: 'content', content: 'Hi' },
      { type: 'usage', promptTokens: 2, completionTokens: 1 },
    ])
  })

  it('assembles a tool call from fragments and flushes on finish', () => {
    const deltas = [
      { toolCalls: [{ index: 0, id: 'c1', name: 'askModel', argsDelta: '{"pro' }] },
      { toolCalls: [{ index: 0, argsDelta: 'mpt":"hi"}' }] },
      { finishReason: 'tool_calls' as const },
    ]
    let st = emptyFoldState()
    const out: StreamChunk[] = []
    for (const d of deltas) {
      const [s, chunks] = foldDelta(st, d)
      st = s
      out.push(...chunks)
    }
    expect(out).toEqual([
      { type: 'tool_call', toolCall: { id: 'c1', name: 'askModel', arguments: '{"prompt":"hi"}' } },
      { type: 'finish', reason: 'tool_calls' },
    ])
  })

  it('emits finish:stop when no tool calls pending', () => {
    const [, chunks] = foldDelta(emptyFoldState(), { finishReason: 'stop' })
    expect(chunks).toEqual([{ type: 'finish', reason: 'stop' }])
  })
})
