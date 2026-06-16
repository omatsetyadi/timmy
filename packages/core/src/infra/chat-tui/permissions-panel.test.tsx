import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { PermissionsPanel } from './permissions-panel'

describe('PermissionsPanel', () => {
  it('renders the mode and each tool override', () => {
    const { lastFrame } = render(
      <PermissionsPanel
        perms={{ mode: 'default', tools: { runAppleScript: 'allow', webSearch: 'ask' } }}
        selected={0}
      />,
    )
    const out = lastFrame()!
    expect(out).toContain('mode: default')
    expect(out).toContain('runAppleScript')
    expect(out).toContain('allow')
    expect(out).toContain('webSearch')
  })

  it('handles no tool overrides', () => {
    const { lastFrame } = render(<PermissionsPanel perms={{ mode: 'yolo' }} selected={0} />)
    expect(lastFrame()).toContain('mode: yolo')
  })
})
