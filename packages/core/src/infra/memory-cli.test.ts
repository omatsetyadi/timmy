import { describe, it, expect } from 'vitest'
import { parseProps, formatEntity } from './memory-cli'

describe('memory-cli helpers', () => {
  it('parseProps splits on first =, keeps later =, ignores no-= tokens', () => {
    expect(parseProps(['role=builder', 'note=a=b', 'bad'])).toEqual({
      role: 'builder',
      note: 'a=b',
    })
  })
  it('formatEntity renders kind, name, props, id', () => {
    const s = formatEntity({
      id: 'x1',
      kind: 'person',
      name: 'Omat',
      properties: { role: 'builder' },
    })
    expect(s).toContain('person')
    expect(s).toContain('Omat')
    expect(s).toContain('role')
    expect(s).toContain('x1')
  })
})
