import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginLoader } from './plugin-loader'

const fixtureDir = () => {
  const root = mkdtempSync(join(tmpdir(), 'plugins-'))
  const good = join(root, 'good')
  mkdirSync(good)
  writeFileSync(
    join(good, 'index.js'),
    "module.exports.default = { name:'good', version:'1', tools:[{name:'noop',description:'d',parameters:{type:'object',properties:{}},riskLevel:'safe',execute:async()=>({ok:true})}] }",
  )
  const bad = join(root, 'bad')
  mkdirSync(bad)
  writeFileSync(join(bad, 'index.js'), 'module.exports.default = { name: 42 }')
  return root
}

it.effect('loads valid plugins, skips malformed', () =>
  Effect.gen(function* () {
    const plugins = yield* PluginLoader.load(fixtureDir())
    expect(plugins.map((p) => p.name)).toEqual(['good'])
    expect(plugins[0]!.tools[0]!.name).toBe('noop')
  }),
)

// Security: a plugin name containing ':' would let it forge another plugin's keychain
// namespace (keys are stored as `<pluginName>:<key>`). PluginSchema validates names
// colon-free, so a colon-named plugin fails decode and the loader logs-and-skips it.
it.effect('skips a plugin whose name contains the keychain delimiter (:)', () =>
  Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), 'plugins-'))
    const evil = join(root, 'evil')
    mkdirSync(evil)
    writeFileSync(
      join(evil, 'index.js'),
      "module.exports.default = { name:'evil:x', version:'1', tools:[{name:'noop',description:'d',parameters:{type:'object',properties:{}},riskLevel:'safe',execute:async()=>({ok:true})}] }",
    )
    const plugins = yield* PluginLoader.load(root)
    expect(plugins.map((p) => p.name)).not.toContain('evil:x')
    expect(plugins).toEqual([])
  }),
)

const TOOL =
  "tools:[{name:'noop',description:'d',parameters:{type:'object',properties:{}},riskLevel:'safe',execute:async()=>({ok:true})}]"
const writePlugin = (root: string, dir: string, body: string): void => {
  const d = join(root, dir)
  mkdirSync(d)
  writeFileSync(join(d, 'index.js'), `module.exports.default = ${body}`)
}

// Graceful migration: a plugin with NO apiVersion is loaded (with a deprecation warning),
// so existing/unversioned plugins keep working. Only an EXPLICITLY out-of-range version
// is skipped.
it.effect('loads a legacy plugin that declares no apiVersion', () =>
  Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), 'plugins-'))
    writePlugin(root, 'legacy', `{ name:'legacy', version:'1', ${TOOL} }`)
    const plugins = yield* PluginLoader.load(root)
    expect(plugins.map((p) => p.name)).toEqual(['legacy'])
  }),
)

it.effect('skips a plugin whose apiVersion is newer than this host supports', () =>
  Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), 'plugins-'))
    writePlugin(root, 'future', `{ apiVersion:999, name:'future', version:'1', ${TOOL} }`)
    writePlugin(root, 'okp', `{ apiVersion:1, name:'okp', version:'1', ${TOOL} }`)
    const plugins = yield* PluginLoader.load(root)
    expect(plugins.map((p) => p.name)).toEqual(['okp'])
  }),
)

it.effect('keeps the first of two plugins sharing a name, skips the later', () =>
  Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), 'plugins-'))
    writePlugin(root, 'a-dir', `{ apiVersion:1, name:'dup', version:'1', ${TOOL} }`)
    writePlugin(root, 'b-dir', `{ apiVersion:1, name:'dup', version:'2', ${TOOL} }`)
    const plugins = yield* PluginLoader.load(root)
    expect(plugins).toHaveLength(1)
    expect(plugins[0]!.name).toBe('dup')
  }),
)

it.effect('skips a plugin that declares two tools with the same name', () =>
  Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), 'plugins-'))
    const dupTools =
      "tools:[{name:'t',description:'d',parameters:{type:'object',properties:{}},riskLevel:'safe',execute:async()=>({ok:true})},{name:'t',description:'d2',parameters:{type:'object',properties:{}},riskLevel:'safe',execute:async()=>({ok:true})}]"
    writePlugin(root, 'clash', `{ apiVersion:1, name:'clash', version:'1', ${dupTools} }`)
    const plugins = yield* PluginLoader.load(root)
    expect(plugins).toEqual([])
  }),
)

// Resilience: a path that exists but is a FILE (not a dir) makes readdirSync throw
// ENOTDIR synchronously. The loader must degrade to [] rather than kill the fiber.
it.effect('returns [] when the plugins path is a file, not a directory', () =>
  Effect.gen(function* () {
    const f = join(mkdtempSync(join(tmpdir(), 'plugins-')), 'notadir')
    writeFileSync(f, 'x')
    const plugins = yield* PluginLoader.load(f)
    expect(plugins).toEqual([])
  }),
)

// Integration: load the REAL tsup CJS bundle produced by the `timmy-plugin-machine`
// package (Task 2 output). This proves the CommonJS double-default interop works
// against actual tsup output, not just the synthetic fixture above. We copy the
// bundle into a temp plugins dir at test time rather than pointing the loader at an
// absolute path. If the sibling repo/bundle is absent (e.g. CI), the case is skipped.
// Resolve the bundle relative to this monorepo's location: <ws>/timmy/packages/core/...
// `__dirname` (CJS global) is used because timmy-core compiles to CommonJS output, where
// `import.meta` is disallowed by tsc.
// __dirname is dist/domain/tools at runtime; the six `..` segments below resolve to
// <workspace>/timmy-plugin-machine/dist/index.js.
const realBundle = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'timmy-plugin-machine',
  'dist',
  'index.js',
)

const maybe = existsSync(realBundle) ? it.effect : it.effect.skip
maybe('loads the real timmy-plugin-machine tsup bundle (machine, base + app-control tools)', () =>
  Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), 'plugins-real-'))
    const dir = join(root, 'timmy-plugin-machine')
    mkdirSync(dir)
    copyFileSync(realBundle, join(dir, 'index.js'))
    const plugins = yield* PluginLoader.load(root)
    expect(plugins.map((p) => p.name)).toEqual(['machine'])
    const names = plugins[0]!.tools.map((t) => t.name)
    // base 5 + app-control 3 (on macOS); assert the app-control ones are present + all runnable.
    expect(names).toEqual(
      expect.arrayContaining(['runAppleScript', 'listRunningApps', 'appControlDoctor']),
    )
    expect(plugins[0]!.tools.every((t) => typeof t.execute === 'function')).toBe(true)
  }),
)
