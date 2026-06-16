import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { ChatInput } from './chat-input'
import { fromValue } from './editor'

const noop = (): void => {}
const props = (
  over: Partial<React.ComponentProps<typeof ChatInput>>,
): React.ComponentProps<typeof ChatInput> => ({
  state: fromValue(''),
  onState: noop,
  onSubmit: noop,
  onHistoryPrev: noop,
  onHistoryNext: noop,
  ...over,
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

describe('ChatInput', () => {
  it('inserts a typed char at the cursor via onState', async () => {
    const onState = vi.fn()
    // value 'ac' cursor 1 -> typing 'b' -> {value:'abc',cursor:2}
    const { stdin } = render(
      <ChatInput {...props({ state: { value: 'ac', cursor: 1 }, onState })} />,
    )
    stdin.write('b')
    await flush()
    expect(onState).toHaveBeenCalledWith({ value: 'abc', cursor: 2 })
  })

  it('leftArrow calls onState with the cursor decreased', async () => {
    const onState = vi.fn()
    const { stdin } = render(
      <ChatInput {...props({ state: { value: 'abc', cursor: 2 }, onState })} />,
    )
    stdin.write('\x1b[D') // Left
    await flush()
    expect(onState).toHaveBeenCalledWith({ value: 'abc', cursor: 1 })
  })

  it('upArrow on a single-line value calls onHistoryPrev (not onState)', async () => {
    const onState = vi.fn()
    const onHistoryPrev = vi.fn()
    const { stdin } = render(
      <ChatInput {...props({ state: { value: 'abc', cursor: 1 }, onState, onHistoryPrev })} />,
    )
    stdin.write('\x1b[A') // Up
    await flush()
    expect(onHistoryPrev).toHaveBeenCalledTimes(1)
    expect(onState).not.toHaveBeenCalled()
  })

  it('upArrow on a multi-line value (cursor on line 2) calls onState, NOT onHistoryPrev', async () => {
    const onState = vi.fn()
    const onHistoryPrev = vi.fn()
    // value 'ab\ncd' cursor 4 (line1 col1) -> moveUp -> cursor 1
    const { stdin } = render(
      <ChatInput {...props({ state: { value: 'ab\ncd', cursor: 4 }, onState, onHistoryPrev })} />,
    )
    stdin.write('\x1b[A') // Up
    await flush()
    expect(onState).toHaveBeenCalledWith({ value: 'ab\ncd', cursor: 1 })
    expect(onHistoryPrev).not.toHaveBeenCalled()
  })

  it('downArrow at the last line calls onHistoryNext', async () => {
    const onState = vi.fn()
    const onHistoryNext = vi.fn()
    const { stdin } = render(
      <ChatInput {...props({ state: { value: 'abc', cursor: 1 }, onState, onHistoryNext })} />,
    )
    stdin.write('\x1b[B') // Down
    await flush()
    expect(onHistoryNext).toHaveBeenCalledTimes(1)
    expect(onState).not.toHaveBeenCalled()
  })

  it('Enter calls onSubmit with the value', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<ChatInput {...props({ state: fromValue('hello'), onSubmit })} />)
    stdin.write('\r') // Enter
    await flush()
    expect(onSubmit).toHaveBeenCalledWith('hello')
  })

  it('renders the value with a cursor', () => {
    const { lastFrame } = render(<ChatInput {...props({ state: fromValue('hi there') })} />)
    expect(lastFrame()).toContain('hi there')
  })
})
