import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Derive a plugin's install name from a source path, robust to a trailing slash:
 *  `installLocal('./foo/')` and `installLocal('./foo')` both yield `foo`. */
function pluginName(src: string): string {
  return basename(src.replace(/[/\\]+$/, ''))
}

/** Copy a *built*, self-contained local plugin into `<pluginsDir>/<name>/` and return
 *  its name. The bundle ships its own `dist/index.js`, so `node_modules` (a pnpm
 *  symlink farm — circular, huge, and irrelevant) and `.git` are excluded from the copy.
 *
 *  Pure fs: the caller (CLI dispatch) is responsible for validating that the source has a
 *  built entry (`dist/index.js` or `index.js`) before invoking this. */
export function installLocal(src: string, pluginsDir: string): string {
  const name = pluginName(src)
  const dest = join(pluginsDir, name)
  cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const b = basename(s)
      return b !== 'node_modules' && b !== '.git'
    },
  })
  return name
}

/** Names of the installed plugins (immediate subdirectories of `pluginsDir`).
 *  Returns `[]` when the directory does not exist. */
export function listInstalled(pluginsDir: string): string[] {
  return existsSync(pluginsDir)
    ? readdirSync(pluginsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : []
}

/** Delete an installed plugin. Returns `true` if it existed and was removed, `false`
 *  if there was no such plugin. */
export function remove(pluginsDir: string, name: string): boolean {
  const p = join(pluginsDir, name)
  if (!existsSync(p)) return false
  rmSync(p, { recursive: true, force: true })
  return true
}

/** True when the local source dir has a built entry the loader can import
 *  (`dist/index.js` — preferred — or a bare `index.js`). */
export function hasBuiltEntry(src: string): boolean {
  return existsSync(join(src, 'dist', 'index.js')) || existsSync(join(src, 'index.js'))
}

/** Unwrap a plugin's default export across module formats (mirrors PluginLoader's interop). */
function extractDefault(mod: unknown): unknown {
  const d = (mod as { default?: unknown } | null)?.default
  if (d && typeof d === 'object' && 'default' in (d as object)) {
    return (d as { default: unknown }).default
  }
  return d ?? mod
}

/** Load an installed plugin's manifest — its name, tool names, and **declared credential keys** —
 *  so the CLI can tell the user what an installed plugin needs (and the exact set-key command).
 *  Returns null if it can't be read; never throws (it's a display nicety, not a gate). */
export async function readInstalledManifest(
  pluginDir: string,
): Promise<{ name: string; tools: string[]; credentialKeys: string[] } | null> {
  const entry = existsSync(join(pluginDir, 'dist', 'index.js'))
    ? join(pluginDir, 'dist', 'index.js')
    : join(pluginDir, 'index.js')
  if (!existsSync(entry)) return null
  try {
    const p = extractDefault(await import(pathToFileURL(entry).href)) as {
      name?: unknown
      tools?: { name?: unknown }[]
      credentials?: { key?: unknown }[]
    } | null
    if (!p || typeof p !== 'object') return null
    return {
      name: String(p.name ?? ''),
      tools: Array.isArray(p.tools) ? p.tools.map((t) => String(t.name)) : [],
      credentialKeys: Array.isArray(p.credentials) ? p.credentials.map((c) => String(c.key)) : [],
    }
  } catch {
    return null
  }
}

/** Recognize any supported GitHub source: the `github:` shorthand, an https/http GitHub URL
 *  (optionally `www.`), or a `git@github.com:` SSH URL. Local paths + other hosts → false.
 *  Used by the CLI to route a source to {@link installFromGithub} vs a local install. */
export function isGithubSource(src: string): boolean {
  return (
    src.startsWith('github:') ||
    /^git@github\.com:/i.test(src) ||
    /^https?:\/\/(?:www\.)?github\.com\//i.test(src)
  )
}

/** Parse any GitHub source into `{ user, repo, ref? }`. Accepts (all tolerate a trailing `.git`):
 *  - `github:user/repo[#ref]` (shorthand)
 *  - `https://github.com/user/repo[.git][/]` (also `http`/`www.`); branch as `#ref` or `/tree/<ref>`
 *  - `git@github.com:user/repo[.git]`
 *  No I/O — exported for testing the parse. Throws on anything that isn't a GitHub source. */
export function parseGithubSource(src: string): { user: string; repo: string; ref?: string } {
  const fail = () =>
    new Error(
      `invalid GitHub source '${src}' — expected github:user/repo or https://github.com/user/repo`,
    )
  let s = src.trim()
  let ref: string | undefined
  const hash = s.indexOf('#')
  if (hash !== -1) {
    ref = s.slice(hash + 1) || undefined
    s = s.slice(0, hash)
  }
  let path: string
  if (s.startsWith('github:')) path = s.slice('github:'.length)
  else if (/^git@github\.com:/i.test(s)) path = s.slice(s.indexOf(':') + 1)
  else {
    const url = /^https?:\/\/(?:www\.)?github\.com\/(.+)$/i.exec(s)
    if (!url) throw fail()
    path = url[1]!
  }
  path = path.replace(/\/+$/, '') // tolerate a trailing slash
  const tree = /^(.+?)\/tree\/(.+)$/.exec(path) // a web URL may carry the branch as /tree/<ref>
  if (tree) {
    path = tree[1]!
    ref = ref ?? tree[2]
  }
  const m = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(path)
  if (!m) throw fail()
  return { user: m[1]!, repo: m[2]!, ref }
}

/** Release asset URLs for a plugin source: the prebuilt self-contained bundle (`index.js`) + its
 *  `SHA256SUMS`. A `ref` targets that tag's release; otherwise `latest`. Pure (exported for tests). */
export function pluginReleaseUrls(source: string): { repo: string; bundle: string; sums: string } {
  const { user, repo, ref } = parseGithubSource(source)
  const base = ref
    ? `https://github.com/${user}/${repo}/releases/download/${ref}`
    : `https://github.com/${user}/${repo}/releases/latest/download`
  return { repo, bundle: `${base}/index.js`, sums: `${base}/SHA256SUMS` }
}

/** Verify a downloaded bundle against a `SHA256SUMS` body (`<hash>  <name>` lines). Throws on a
 *  missing entry or a mismatch. Pure (exported for tests). */
export function verifyChecksum(data: Buffer, sumsText: string, asset: string): void {
  const expected = sumsText
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === asset || name === `*${asset}`)?.[0]
  if (!expected) throw new Error(`no checksum for ${asset} in SHA256SUMS`)
  const actual = createHash('sha256').update(data).digest('hex')
  if (expected !== actual) throw new Error(`checksum mismatch for ${asset}`)
}

const fetchBytes = async (url: string): Promise<Buffer> => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`download failed (${r.status}): ${url}`)
  return Buffer.from(await r.arrayBuffer())
}
const fetchText = async (url: string): Promise<string> => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`fetch failed (${r.status}): ${url}`)
  return r.text()
}

/**
 * Install a plugin from its GitHub **Release** — fetch the prebuilt, self-contained `index.js`
 * bundle + `SHA256SUMS`, verify the checksum, then drop it into `<pluginsDir>/<repo>/index.js`.
 * **No clone, no npm, no build** — works on a machine without Node/git/a toolchain (the whole point:
 * plugins build at *publish*, never at install). Dev inner-loop still uses `installLocal('./dist')`.
 * `baseUrlOverride` points at an alternate source (tests/dev). Returns the installed name (`repo`).
 */
export async function installFromGithub(
  source: string,
  pluginsDir: string,
  baseUrlOverride?: string,
): Promise<string> {
  const { repo, bundle, sums } = pluginReleaseUrls(source)
  const bundleUrl = baseUrlOverride ? `${baseUrlOverride}/index.js` : bundle
  const sumsUrl = baseUrlOverride ? `${baseUrlOverride}/SHA256SUMS` : sums
  const data = await fetchBytes(bundleUrl)
  verifyChecksum(data, await fetchText(sumsUrl), 'index.js')
  const dest = join(pluginsDir, repo)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'index.js'), data)
  return repo
}

/** A first-party plugin `timmy init` offers to install out-of-the-box. `source` is the
 *  github-install spec (same one `plugin install` takes); `blurb` is the one-line pitch. */
export interface DefaultPlugin {
  readonly name: string
  readonly source: string
  readonly blurb: string
}

/** The recommended set a fresh Timmy ships with — so a new install has capabilities, not an
 *  empty brain. Order = install order. (Vision + reasoning are core; these add hands.) */
export const DEFAULT_PLUGINS: readonly DefaultPlugin[] = [
  {
    name: 'machine',
    source: 'github:omatsetyadi/timmy-plugin-machine',
    blurb: 'control macOS apps — AppleScript, app focus, a script library',
  },
  {
    name: 'web',
    source: 'github:omatsetyadi/timmy-plugin-web',
    blurb: 'web search + fetch a URL (needs a Tavily API key)',
  },
  {
    name: 'shell',
    source: 'github:omatsetyadi/timmy-plugin-shell',
    blurb: 'run shell commands — runCommand, with a safety classifier',
  },
]

export interface DefaultInstallResult {
  readonly name: string
  readonly ok: boolean
  readonly error?: string
}

/** Install each default plugin via the injected `install` (the same github-install path the
 *  `plugin install` command uses, curried with the plugins dir). Continue-on-failure: one
 *  plugin's clone/build error is captured and the rest still install — `timmy init` has already
 *  written the config, so a plugin failure must never abort setup. Returns a per-plugin result
 *  so the caller can summarize what landed and what to retry. */
export async function installDefaults(
  plugins: readonly DefaultPlugin[],
  install: (plugin: DefaultPlugin) => Promise<void> | void,
  log: (msg: string) => void,
): Promise<DefaultInstallResult[]> {
  const results: DefaultInstallResult[] = []
  for (const p of plugins) {
    log(`\n  installing ${p.name} — ${p.blurb}…`)
    try {
      await install(p)
      results.push({ name: p.name, ok: true })
      log(`  ✓ ${p.name}`)
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      results.push({ name: p.name, ok: false, error })
      log(`  ✗ ${p.name} — ${error}\n    retry later: timmy plugin install ${p.source}`)
    }
  }
  return results
}
