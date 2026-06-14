import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

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

/** Parse a `github:user/repo[#ref]` spec (tolerates a trailing `.git`). Throws on a
 *  malformed spec. Exported for testing the parse without performing any I/O. */
export function parseGithubSpec(spec: string): { user: string; repo: string; ref?: string } {
  const m = /^github:([^/\s]+)\/([^#\s]+?)(?:\.git)?(?:#(.+))?$/.exec(spec)
  if (!m) throw new Error(`invalid github spec '${spec}' — expected github:user/repo`)
  return { user: m[1]!, repo: m[2]!, ref: m[3] }
}

/** Install a plugin from a `github:user/repo[#ref]` spec: shallow-clone the repo,
 *  `npm install` + `npm run build` (which resolves the published deps and produces the
 *  self-contained bundle), then copy the built plugin into `<pluginsDir>/<repo>/`.
 *  Uses `npm` (not pnpm) for the at-target build so it's independent of any pnpm
 *  workspace config / release-age cooldown. Returns the installed name (`repo`). */
export function installFromGithub(spec: string, pluginsDir: string): string {
  const { user, repo, ref } = parseGithubSpec(spec)
  const url = `https://github.com/${user}/${repo}.git`
  const tmp = mkdtempSync(join(tmpdir(), 'timmy-plugin-'))
  try {
    execFileSync('git', ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), url, tmp], {
      stdio: 'inherit',
    })
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error'], {
      cwd: tmp,
      stdio: 'inherit',
    })
    execFileSync('npm', ['run', 'build'], { cwd: tmp, stdio: 'inherit' })
    if (!hasBuiltEntry(tmp)) {
      throw new Error(
        `'${spec}' produced no dist/index.js — its build script must build the plugin`,
      )
    }
    const dest = join(pluginsDir, repo)
    rmSync(dest, { recursive: true, force: true })
    cpSync(tmp, dest, {
      recursive: true,
      filter: (s) => {
        const b = basename(s)
        return b !== 'node_modules' && b !== '.git'
      },
    })
    return repo
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
