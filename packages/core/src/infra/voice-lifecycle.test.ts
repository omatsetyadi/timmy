import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isVoiceInstalled, preflight } from './voice-lifecycle'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-voice-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('isVoiceInstalled', () => {
  it('is false for an empty dir, true once the repo (pyproject.toml) is present', () => {
    expect(isVoiceInstalled(dir)).toBe(false)
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "timmy-voice"\n')
    expect(isVoiceInstalled(dir)).toBe(true)
  })
})

describe('preflight', () => {
  it('reports python + uv presence as booleans', () => {
    const p = preflight()
    expect(typeof p.python).toBe('boolean')
    expect(typeof p.uv).toBe('boolean')
  })
})
