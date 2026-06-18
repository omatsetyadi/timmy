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
  it('reports uv presence as a boolean (uv provisions its own Python — no python check)', () => {
    expect(typeof preflight().uv).toBe('boolean')
  })
})
