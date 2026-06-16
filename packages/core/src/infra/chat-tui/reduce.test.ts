import { describe, it, expect } from 'vitest'
import { initialState, reduceFrame, withUserMessage, type ChatState } from './reduce'

const s0 = initialState()

describe('reduceFrame', () => {
  it('thread frame sets the thread id', () => {
    expect(reduceFrame(s0, { kind: 'thread', threadId: 't1' }).threadId).toBe('t1')
  })
  it('content chunk creates a text part', () => {
    const s = reduceFrame(s0, { kind: 'chunk', chunk: { type: 'content', content: 'hi' } })
    expect(s.parts).toEqual([{ type: 'text', text: 'hi' }])
    expect(s.transcript).toEqual([])
  })
  it('two content chunks merge into one text part', () => {
    let s = reduceFrame(s0, { kind: 'chunk', chunk: { type: 'content', content: 'he' } })
    s = reduceFrame(s, { kind: 'chunk', chunk: { type: 'content', content: 'llo' } })
    expect(s.parts).toEqual([{ type: 'text', text: 'hello' }])
  })
  it('tool_call pushes a tool part AFTER existing text, preserving order', () => {
    let s = reduceFrame(s0, { kind: 'chunk', chunk: { type: 'content', content: 'opening' } })
    s = reduceFrame(s, {
      kind: 'chunk',
      chunk: { type: 'tool_call', toolCall: { id: '1', name: 'web__webSearch', arguments: '{}' } },
    })
    expect(s.parts).toEqual([
      { type: 'text', text: 'opening' },
      { type: 'tool', name: 'web__webSearch' },
    ])
  })
  it('content after a tool part starts a NEW text part (does not merge into the tool)', () => {
    let s = reduceFrame(s0, { kind: 'chunk', chunk: { type: 'content', content: 'opening' } })
    s = reduceFrame(s, {
      kind: 'chunk',
      chunk: { type: 'tool_call', toolCall: { id: '1', name: 'web__webSearch', arguments: '{}' } },
    })
    s = reduceFrame(s, { kind: 'chunk', chunk: { type: 'content', content: 'done' } })
    expect(s.parts).toEqual([
      { type: 'text', text: 'opening' },
      { type: 'tool', name: 'web__webSearch' },
      { type: 'text', text: 'done' },
    ])
  })
  it('non-content/tool chunks leave state unchanged', () => {
    const s = reduceFrame(s0, {
      kind: 'chunk',
      chunk: { type: 'usage', promptTokens: 1, completionTokens: 2 },
    })
    expect(s).toBe(s0)
  })
  it('confirm frame surfaces the request', () => {
    const s = reduceFrame(s0, {
      kind: 'confirm',
      id: 'c1',
      tool: 'runCommand',
      description: 'x',
      always: { scope: 'command', label: 'git commit' },
    })
    expect(s.confirm).toEqual({
      id: 'c1',
      tool: 'runCommand',
      description: 'x',
      always: { scope: 'command', label: 'git commit' },
    })
  })
  it('done commits the turn parts to the transcript and clears parts', () => {
    let s: ChatState = reduceFrame(s0, {
      kind: 'chunk',
      chunk: { type: 'content', content: 'opening' },
    })
    s = reduceFrame(s, {
      kind: 'chunk',
      chunk: { type: 'tool_call', toolCall: { id: '1', name: 'runAppleScript', arguments: '{}' } },
    })
    s = reduceFrame(s, { kind: 'done' })
    expect(s.transcript).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'opening' },
          { type: 'tool', name: 'runAppleScript' },
        ],
      },
    ])
    expect(s.parts).toEqual([])
  })
  it('done with no parts does not commit an empty turn', () => {
    const s = reduceFrame(s0, { kind: 'done' })
    expect(s.transcript).toEqual([])
    expect(s.parts).toEqual([])
  })
  it('withUserMessage pushes a user item with a single text part', () => {
    const s = withUserMessage(s0, 'open photo booth')
    expect(s.transcript).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'open photo booth' }] },
    ])
  })
})
