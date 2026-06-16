import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { Transcript } from './transcript'

describe('Transcript', () => {
  it('renders a user item and a multi-part assistant item with an inline tool line', () => {
    const r = render(
      <Transcript
        items={[
          { role: 'user', parts: [{ type: 'text', text: 'open photo booth' }] },
          {
            role: 'assistant',
            parts: [
              { type: 'text', text: 'opening' },
              { type: 'tool', name: 'runAppleScript' },
              { type: 'text', text: 'done' },
            ],
          },
        ]}
      />,
    )
    const out = r.frames.join('\n') // Static output lands across frames; join per harness note
    expect(out).toContain('you')
    expect(out).toContain('open photo booth')
    expect(out).toContain('timmy')
    expect(out).toContain('opening')
    expect(out).toContain('⏺ runAppleScript')
    expect(out).toContain('done')
  })

  it('renders a memory part as an inline recalled line with the entities', () => {
    const r = render(
      <Transcript
        items={[
          {
            role: 'assistant',
            parts: [{ type: 'memory', entities: ['Omat', 'Jitera'] }],
          },
        ]}
      />,
    )
    const out = r.frames.join('\n')
    expect(out).toContain('recalled')
    expect(out).toContain('Omat')
    expect(out).toContain('Jitera')
  })
})
