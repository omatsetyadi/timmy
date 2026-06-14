import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'
import { parseOllamaLine } from './ollama-parser'

it.effect('parses content, thinking, finish; skips malformed', () =>
  Effect.gen(function* () {
    expect(
      yield* parseOllamaLine(JSON.stringify({ message: { content: 'Hi' }, done: false })),
    ).toEqual({ type: 'content', content: 'Hi' })
    expect(
      yield* parseOllamaLine(JSON.stringify({ message: { thinking: 'hmm' }, done: false })),
    ).toEqual({ type: 'thinking', content: 'hmm' })
    expect(yield* parseOllamaLine(JSON.stringify({ done: true }))).toEqual({
      type: 'finish',
      reason: 'stop',
    })
    expect(yield* parseOllamaLine('{ not json')).toBeNull() // degrade-don't-die
  }),
)

it.effect('parses an Ollama tool_call line', () =>
  Effect.gen(function* () {
    const line = JSON.stringify({
      message: {
        content: '',
        tool_calls: [{ function: { name: 'openApp', arguments: { name: 'Spotify' } } }],
      },
      done: false,
    })
    const chunk = yield* parseOllamaLine(line)
    expect(chunk).toEqual({
      type: 'tool_call',
      toolCall: {
        id: chunk && chunk.type === 'tool_call' ? chunk.toolCall.id : '',
        name: 'openApp',
        arguments: '{"name":"Spotify"}',
      },
    })
  }),
)
