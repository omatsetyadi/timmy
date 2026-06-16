import { describe, it, expect } from 'vitest'
import { historyNav } from './history'

describe('historyNav', () => {
  const h = ['first', 'second', 'third'] // oldest→newest
  it('up from the bottom recalls the newest', () => {
    expect(historyNav(h, null, 'up')).toEqual({ index: 2, value: 'third' })
  })
  it('up again recalls older', () => {
    expect(historyNav(h, 2, 'up')).toEqual({ index: 1, value: 'second' })
  })
  it('down past the newest clears to a fresh line', () => {
    expect(historyNav(h, 2, 'down')).toEqual({ index: null, value: '' })
  })
  it('up at the oldest stays put', () => {
    expect(historyNav(h, 0, 'up')).toEqual({ index: 0, value: 'first' })
  })
})
