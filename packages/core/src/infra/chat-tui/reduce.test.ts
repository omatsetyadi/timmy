import { describe, it, expect } from 'vitest'
import { friendlyError, initialState, reduceFrame, withUserMessage, type ChatState } from './reduce'

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
  it('non-content/tool chunks (usage) leave state unchanged', () => {
    const s = reduceFrame(s0, {
      kind: 'chunk',
      chunk: { type: 'usage', promptTokens: 1, completionTokens: 2 },
    })
    expect(s).toBe(s0)
  })
  it('an error chunk pushes a visible error part (never silently dropped)', () => {
    const s = reduceFrame(s0, {
      kind: 'chunk',
      chunk: { type: 'error', message: 'chat failed (500)' },
    })
    expect(s.parts).toEqual([{ type: 'error', message: 'chat failed (500)' }])
  })
  it('error parts after text preserve order and commit to the transcript on done', () => {
    let s = reduceFrame(s0, { kind: 'chunk', chunk: { type: 'content', content: 'partial' } })
    s = reduceFrame(s, { kind: 'chunk', chunk: { type: 'error', message: 'boom' } })
    s = reduceFrame(s, { kind: 'done' })
    expect(s.transcript).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'partial' },
          { type: 'error', message: 'boom' },
        ],
      },
    ])
  })
  it('a memory frame appends a memory part to the in-progress turn', () => {
    const s = reduceFrame(initialState(), { kind: 'memory', entities: ['Omat', 'Jitera'] })
    expect(s.parts).toEqual([{ type: 'memory', entities: ['Omat', 'Jitera'] }])
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

describe('friendlyError', () => {
  it('appends an API-key hint for a 401/403', () => {
    expect(friendlyError('chat failed (401)')).toMatch(/check your API key/i)
    expect(friendlyError('request failed: 403 Forbidden')).toMatch(/check your API key/i)
  })
  it('appends a model/provider hint for a 404', () => {
    expect(friendlyError('chat failed (404)')).toMatch(/check the model.*provider/i)
  })
  it('appends a rate-limit hint for a 429', () => {
    expect(friendlyError('429 Too Many Requests')).toMatch(/rate limit/i)
  })
  it('leaves an unrecognized error message unchanged', () => {
    expect(friendlyError('something odd happened')).toBe('something odd happened')
  })
})
