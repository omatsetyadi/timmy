import { describe, it, expect } from 'vitest'
import { parseFrame, renderChunk } from './frames'

describe('parseFrame (NDJSON line → frame)', () => {
  it('reads the opening {thread_id} line', () => {
    expect(parseFrame('{"thread_id":"t-123"}')).toEqual({ kind: 'thread', threadId: 't-123' })
  })

  it('reads the closing {done:true} line', () => {
    expect(parseFrame('{"done":true}')).toEqual({ kind: 'done' })
  })

  it('reads a confirm_required line as its own kind (handled interactively)', () => {
    expect(
      parseFrame(
        '{"type":"confirm_required","id":"c1","tool":"askClaude","description":"run ls","always":{"scope":"tool","label":"x"}}',
      ),
    ).toEqual({
      kind: 'confirm',
      id: 'c1',
      tool: 'askClaude',
      description: 'run ls',
      always: { scope: 'tool', label: 'x' },
    })
  })

  it('parseFrame maps a memory_recall chunk to a memory frame', () => {
    expect(
      parseFrame(JSON.stringify({ type: 'memory_recall', entities: ['Omat', 'Jitera'] })),
    ).toEqual({ kind: 'memory', entities: ['Omat', 'Jitera'] })
  })

  it('reads a typed StreamChunk line as kind:chunk', () => {
    expect(parseFrame('{"type":"content","content":"hi"}')).toEqual({
      kind: 'chunk',
      chunk: { type: 'content', content: 'hi' },
    })
  })

  it('ignores blank lines', () => {
    expect(parseFrame('   ')).toEqual({ kind: 'ignore' })
  })

  it('ignores malformed JSON instead of throwing', () => {
    expect(parseFrame('{not json')).toEqual({ kind: 'ignore' })
  })
})

describe('renderChunk (StreamChunk → terminal output)', () => {
  it('passes content through verbatim', () => {
    expect(renderChunk({ type: 'content', content: 'hello' })).toBe('hello')
  })

  it('hides thinking by default', () => {
    expect(renderChunk({ type: 'thinking', content: 'pondering' })).toBe('')
  })

  it('shows thinking (dimmed) when enabled', () => {
    const out = renderChunk({ type: 'thinking', content: 'pondering' }, { showThinking: true })
    expect(out).toContain('pondering')
  })

  it('labels a tool call with its name', () => {
    const out = renderChunk({
      type: 'tool_call',
      toolCall: { id: '1', name: 'askModel', arguments: '{}' },
    })
    expect(out).toContain('askModel')
    expect(out).toContain('→')
  })

  it('renders an error chunk with its message', () => {
    expect(renderChunk({ type: 'error', message: 'boom' })).toContain('boom')
  })

  it('renders usage with token counts', () => {
    const out = renderChunk({ type: 'usage', promptTokens: 10, completionTokens: 5 })
    expect(out).toContain('10')
    expect(out).toContain('5')
  })

  it('renders nothing for a finish chunk', () => {
    expect(renderChunk({ type: 'finish', reason: 'stop' })).toBe('')
  })
})
