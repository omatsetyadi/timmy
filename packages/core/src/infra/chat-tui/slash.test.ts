import { describe, it, expect } from 'vitest'
import { SLASH_COMMANDS, filterCommands, parseSlash } from './slash'

describe('slash', () => {
  it('parseSlash detects a slash command name', () => {
    expect(parseSlash('/per')).toEqual({ isSlash: true, query: 'per' })
    expect(parseSlash('hello')).toEqual({ isSlash: false, query: '' })
  })
  it('filterCommands matches by prefix', () => {
    const names = filterCommands('th').map((c) => c.name)
    expect(names).toContain('think')
    expect(names).not.toContain('exit')
  })
  it('empty query returns all commands', () => {
    expect(filterCommands('').length).toBe(SLASH_COMMANDS.length)
  })
})
