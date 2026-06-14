import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
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
