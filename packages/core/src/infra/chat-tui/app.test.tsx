import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { App, banner } from './app'

const daemon = { base: 'http://127.0.0.1:1', headers: {} }

describe('banner', () => {
  it('is a one-time header box with the model + a closed border', () => {
    const b = banner('deepseek-v4-flash')
    expect(b).toContain('✻ Timmy')
    expect(b).toContain('deepseek-v4-flash')
    expect(b).toContain('╭') // top border
    expect(b).toContain('╰') // bottom border
  })
})

describe('App', () => {
  it('renders the input prompt and status line on mount (welcome banner is printed separately)', () => {
    const { lastFrame } = render(<App daemon={daemon} initialThread={undefined} />)
    const out = lastFrame()!
    expect(out).not.toContain('✻ Timmy') // banner is NOT in the live region anymore
    expect(out).toContain('›') // bordered ChatInput prompt
    expect(out).toContain('default') // status line mode
  })
  it('typing / opens the slash menu', async () => {
    const { stdin, lastFrame } = render(<App daemon={daemon} initialThread={undefined} />)
    stdin.write('/')
    await new Promise((r) => setTimeout(r, 20))
    expect(lastFrame()).toContain('permissions') // a menu entry
  })
})
