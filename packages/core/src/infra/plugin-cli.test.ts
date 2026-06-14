import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasBuiltEntry, installLocal, listInstalled, remove } from './plugin-cli'

/** Build a fake "built" plugin source dir: `<root>/<name>/dist/index.js` + `package.json`.
 *  Returns the plugin source dir path. */
function fakeBuiltPlugin(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-src-'))
  const src = join(root, name)
  mkdirSync(join(src, 'dist'), { recursive: true })
  writeFileSync(join(src, 'dist', 'index.js'), 'module.exports.default = {}')
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name }))
  return src
}

function emptyPluginsDir(): string {
  return mkdtempSync(join(tmpdir(), 'plugins-dest-'))
}

describe('installLocal', () => {
  it('copies a built plugin into <pluginsDir>/<name>/ and returns the name', () => {
    const src = fakeBuiltPlugin('machine')
    const pluginsDir = emptyPluginsDir()

    const name = installLocal(src, pluginsDir)

    expect(name).toBe('machine')
    expect(existsSync(join(pluginsDir, 'machine', 'dist', 'index.js'))).toBe(true)
    expect(existsSync(join(pluginsDir, 'machine', 'package.json'))).toBe(true)
  })

  it('does NOT copy node_modules', () => {
    const src = fakeBuiltPlugin('withdeps')
    // Add a node_modules tree to the source — it must be excluded from the copy.
    mkdirSync(join(src, 'node_modules', 'junk'), { recursive: true })
    writeFileSync(join(src, 'node_modules', 'junk', 'big.js'), 'x'.repeat(1000))
    const pluginsDir = emptyPluginsDir()

    installLocal(src, pluginsDir)

    expect(existsSync(join(pluginsDir, 'withdeps', 'dist', 'index.js'))).toBe(true)
    expect(existsSync(join(pluginsDir, 'withdeps', 'node_modules'))).toBe(false)
  })

  it('does NOT copy .git', () => {
    const src = fakeBuiltPlugin('withgit')
    // Add a .git tree to the source — it must be excluded from the copy.
    mkdirSync(join(src, '.git'), { recursive: true })
    writeFileSync(join(src, '.git', 'config'), '[core]\n')
    const pluginsDir = emptyPluginsDir()

    installLocal(src, pluginsDir)

    expect(existsSync(join(pluginsDir, 'withgit', 'dist', 'index.js'))).toBe(true)
    expect(existsSync(join(pluginsDir, 'withgit', '.git'))).toBe(false)
  })

  it('strips a trailing slash when deriving the name', () => {
    const src = fakeBuiltPlugin('trailing')
    const pluginsDir = emptyPluginsDir()

    const name = installLocal(`${src}/`, pluginsDir)

    expect(name).toBe('trailing')
    expect(existsSync(join(pluginsDir, 'trailing', 'dist', 'index.js'))).toBe(true)
  })
})

describe('listInstalled', () => {
  it('returns the installed plugin names', () => {
    const pluginsDir = emptyPluginsDir()
    installLocal(fakeBuiltPlugin('alpha'), pluginsDir)
    installLocal(fakeBuiltPlugin('beta'), pluginsDir)

    expect(listInstalled(pluginsDir).sort()).toEqual(['alpha', 'beta'])
  })

  it('returns [] for a non-existent dir', () => {
    expect(listInstalled(join(tmpdir(), 'definitely-not-a-real-plugins-dir-xyz'))).toEqual([])
  })
})

describe('remove', () => {
  it('deletes an installed plugin and returns true', () => {
    const pluginsDir = emptyPluginsDir()
    installLocal(fakeBuiltPlugin('gone'), pluginsDir)
    expect(existsSync(join(pluginsDir, 'gone'))).toBe(true)

    expect(remove(pluginsDir, 'gone')).toBe(true)
    expect(existsSync(join(pluginsDir, 'gone'))).toBe(false)
  })

  it('returns false for a missing plugin', () => {
    const pluginsDir = emptyPluginsDir()
    expect(remove(pluginsDir, 'nope')).toBe(false)
  })
})

describe('hasBuiltEntry', () => {
  it('returns true when <src>/dist/index.js exists', () => {
    const src = mkdtempSync(join(tmpdir(), 'plugin-entry-'))
    mkdirSync(join(src, 'dist'), { recursive: true })
    writeFileSync(join(src, 'dist', 'index.js'), 'module.exports = {}')

    expect(hasBuiltEntry(src)).toBe(true)
  })

  it('returns true when a bare <src>/index.js exists (no dist)', () => {
    const src = mkdtempSync(join(tmpdir(), 'plugin-entry-'))
    writeFileSync(join(src, 'index.js'), 'module.exports = {}')

    expect(hasBuiltEntry(src)).toBe(true)
  })

  it('returns false when neither exists', () => {
    const src = mkdtempSync(join(tmpdir(), 'plugin-entry-'))

    expect(hasBuiltEntry(src)).toBe(false)
  })
})
