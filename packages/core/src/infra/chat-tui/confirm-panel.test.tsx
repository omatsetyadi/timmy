import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { ConfirmPanel } from './confirm-panel'

describe('ConfirmPanel', () => {
  it('shows tool, description, and the always label for a command scope', () => {
    const { lastFrame } = render(
      <ConfirmPanel
        req={{
          id: 'c1',
          tool: 'runCommand',
          description: 'command: git commit -m x',
          always: { scope: 'command', label: 'git commit' },
        }}
      />,
    )
    const out = lastFrame()!
    expect(out).toContain('runCommand')
    expect(out).toContain('git commit -m x')
    expect(out).toContain('always')
    expect(out).toContain('git commit')
  })

  it('labels always with the tool name for a tool scope', () => {
    const { lastFrame } = render(
      <ConfirmPanel
        req={{
          id: 'c2',
          tool: 'runAppleScript',
          description: 'script: tell app',
          always: { scope: 'tool', label: 'runAppleScript' },
        }}
      />,
    )
    expect(lastFrame()).toContain('always allow runAppleScript')
  })
})
