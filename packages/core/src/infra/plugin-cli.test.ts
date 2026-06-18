import { afterEach, describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  DEFAULT_PLUGINS,
  hasBuiltEntry,
  installDefaults,
  installFromGithub,
  installLocal,
  isGithubSource,
  listInstalled,
  parseGithubSource,
  pluginReleaseUrls,
  readInstalledManifest,
  remove,
  verifyChecksum,
  type DefaultPlugin,
} from './plugin-cli'

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

describe('parseGithubSource', () => {
  it('parses the github:user/repo shorthand', () => {
    expect(parseGithubSource('github:omatsetyadi/timmy-plugin-machine')).toEqual({
      user: 'omatsetyadi',
      repo: 'timmy-plugin-machine',
      ref: undefined,
    })
  })

  it('parses an optional #ref and strips a trailing .git', () => {
    expect(parseGithubSource('github:user/repo#v1.2.0')).toMatchObject({
      repo: 'repo',
      ref: 'v1.2.0',
    })
    expect(parseGithubSource('github:user/repo.git')).toMatchObject({ repo: 'repo' })
  })

  it('parses a full https GitHub URL (with .git / trailing slash / www / http)', () => {
    expect(parseGithubSource('https://github.com/user/repo')).toMatchObject({
      user: 'user',
      repo: 'repo',
    })
    expect(parseGithubSource('https://github.com/user/repo.git')).toMatchObject({ repo: 'repo' })
    expect(parseGithubSource('https://github.com/user/repo/')).toMatchObject({ repo: 'repo' })
    expect(parseGithubSource('http://www.github.com/user/repo')).toMatchObject({ repo: 'repo' })
  })

  it('parses a branch from /tree/<ref> or #ref on a URL', () => {
    expect(parseGithubSource('https://github.com/user/repo/tree/dev')).toMatchObject({
      repo: 'repo',
      ref: 'dev',
    })
    expect(parseGithubSource('https://github.com/user/repo#v2')).toMatchObject({ ref: 'v2' })
  })

  it('parses an ssh git@ URL', () => {
    expect(parseGithubSource('git@github.com:user/repo.git')).toMatchObject({
      user: 'user',
      repo: 'repo',
    })
  })

  it('throws on a non-GitHub source', () => {
    expect(() => parseGithubSource('not-a-source')).toThrow(/GitHub source/)
    expect(() => parseGithubSource('https://gitlab.com/u/r')).toThrow(/GitHub source/)
  })
})

describe('readInstalledManifest', () => {
  it('reads name + tools + credential keys from a built plugin', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'pm-')), 'web')
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(
      join(dir, 'dist', 'index.js'),
      `module.exports.default = { name: 'web', tools: [{name:'webSearch'},{name:'fetchUrl'}], credentials: [{key:'tavily_api_key'}] }`,
    )
    expect(await readInstalledManifest(dir)).toEqual({
      name: 'web',
      tools: ['webSearch', 'fetchUrl'],
      credentialKeys: ['tavily_api_key'],
    })
  })

  it('returns null when there is no built entry', async () => {
    expect(await readInstalledManifest(mkdtempSync(join(tmpdir(), 'pm-')))).toBeNull()
  })
})

describe('DEFAULT_PLUGINS', () => {
  it('is the first-party set (machine, web, shell), each a GitHub source', () => {
    expect(DEFAULT_PLUGINS.map((p) => p.name)).toEqual(['machine', 'web', 'shell'])
    for (const p of DEFAULT_PLUGINS) {
      expect(isGithubSource(p.source)).toBe(true)
      expect(p.blurb.length).toBeGreaterThan(0)
    }
  })
})

describe('installDefaults', () => {
  const plugins: DefaultPlugin[] = [
    { name: 'a', source: 'github:u/a', blurb: 'aaa' },
    { name: 'b', source: 'github:u/b', blurb: 'bbb' },
    { name: 'c', source: 'github:u/c', blurb: 'ccc' },
  ]

  it('installs every plugin and reports all ok', async () => {
    const installed: string[] = []
    const results = await installDefaults(
      plugins,
      (p) => {
        installed.push(p.name)
      },
      () => {},
    )
    expect(installed).toEqual(['a', 'b', 'c'])
    expect(results).toEqual([
      { name: 'a', ok: true },
      { name: 'b', ok: true },
      { name: 'c', ok: true },
    ])
  })

  it('continues past a failing plugin and captures its error (init must not abort)', async () => {
    const installed: string[] = []
    const results = await installDefaults(
      plugins,
      (p) => {
        if (p.name === 'b') throw new Error('clone failed')
        installed.push(p.name)
      },
      () => {},
    )
    // a and c still installed despite b throwing
    expect(installed).toEqual(['a', 'c'])
    expect(results).toEqual([
      { name: 'a', ok: true },
      { name: 'b', ok: false, error: 'clone failed' },
      { name: 'c', ok: true },
    ])
  })

  it('awaits an async installer', async () => {
    const order: string[] = []
    await installDefaults(
      [plugins[0]],
      async (p) => {
        await Promise.resolve()
        order.push(p.name)
      },
      () => {},
    )
    expect(order).toEqual(['a'])
  })
})

describe('isGithubSource', () => {
  it('recognizes every GitHub form and rejects local paths / other hosts', () => {
    expect(isGithubSource('github:u/r')).toBe(true)
    expect(isGithubSource('https://github.com/u/r')).toBe(true)
    expect(isGithubSource('http://www.github.com/u/r')).toBe(true)
    expect(isGithubSource('git@github.com:u/r.git')).toBe(true)
    expect(isGithubSource('./local/plugin')).toBe(false)
    expect(isGithubSource('/abs/path')).toBe(false)
    expect(isGithubSource('https://gitlab.com/u/r')).toBe(false)
  })
})

describe('pluginReleaseUrls', () => {
  it('points at the latest release assets (index.js + SHA256SUMS) by default', () => {
    const u = pluginReleaseUrls('github:omatsetyadi/timmy-plugin-web')
    expect(u.repo).toBe('timmy-plugin-web')
    expect(u.bundle).toBe(
      'https://github.com/omatsetyadi/timmy-plugin-web/releases/latest/download/index.js',
    )
    expect(u.sums).toMatch(/\/releases\/latest\/download\/SHA256SUMS$/)
  })

  it('targets a specific tag when the source carries a ref', () => {
    const u = pluginReleaseUrls('github:omatsetyadi/timmy-plugin-web#v1.2.0')
    expect(u.bundle).toBe(
      'https://github.com/omatsetyadi/timmy-plugin-web/releases/download/v1.2.0/index.js',
    )
  })
})

describe('verifyChecksum', () => {
  const data = Buffer.from('plugin-bundle-bytes')
  const hash = createHash('sha256').update(data).digest('hex')

  it('passes when the hash matches the SHA256SUMS entry', () => {
    expect(() => verifyChecksum(data, `${hash}  index.js\n`, 'index.js')).not.toThrow()
  })
  it('throws on a mismatch', () => {
    expect(() => verifyChecksum(data, `deadbeef  index.js\n`, 'index.js')).toThrow(/mismatch/i)
  })
  it('throws when the asset is absent from SHA256SUMS', () => {
    expect(() => verifyChecksum(data, `${hash}  other.js\n`, 'index.js')).toThrow(/no checksum/i)
  })
})

describe('installFromGithub (fetch prebuilt release bundle)', () => {
  let server: Server | undefined
  afterEach(() => server?.close())

  // Serve a fake release (index.js + SHA256SUMS) over a throwaway local HTTP server.
  const serve = (bundle: Buffer, sums: string): Promise<string> =>
    new Promise((resolve) => {
      server = createServer((req, res) => {
        if (req.url === '/index.js') return void res.end(bundle)
        if (req.url === '/SHA256SUMS') return void res.end(sums)
        res.statusCode = 404
        res.end('nope')
      })
      server.listen(0, '127.0.0.1', () => {
        const { port } = server!.address() as AddressInfo
        resolve(`http://127.0.0.1:${port}`)
      })
    })

  it('downloads the verified bundle into <pluginsDir>/<repo>/index.js', async () => {
    const bundle = Buffer.from('module.exports.default = { name: "web", tools: [] }')
    const sums = `${createHash('sha256').update(bundle).digest('hex')}  index.js\n`
    const base = await serve(bundle, sums)
    const dest = emptyPluginsDir()

    const name = await installFromGithub('github:omatsetyadi/timmy-plugin-web', dest, base)
    expect(name).toBe('timmy-plugin-web')
    expect(readFileSync(join(dest, 'timmy-plugin-web', 'index.js'), 'utf8')).toContain(
      'name: "web"',
    )
  })

  it('refuses (and writes nothing) when the checksum does not match', async () => {
    const bundle = Buffer.from('tampered')
    const base = await serve(bundle, 'deadbeef  index.js\n')
    const dest = emptyPluginsDir()

    await expect(installFromGithub('github:me/timmy-plugin-x', dest, base)).rejects.toThrow(
      /mismatch/i,
    )
    expect(existsSync(join(dest, 'timmy-plugin-x'))).toBe(false)
  })
})
