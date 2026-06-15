import { Effect } from 'effect'
import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_API_VERSION, type TimmyPlugin } from 'timmy-sdk'
import { decodePlugin } from './plugin-schema'

/** Accepted plugin-contract range. A plugin declaring an `apiVersion` outside this is
 *  skipped with a clear message. A plugin declaring NONE is loaded with a deprecation
 *  warning (graceful migration for unversioned plugins). */
const MIN_PLUGIN_API = 1
const CURRENT_PLUGIN_API = PLUGIN_API_VERSION

/** Robustly unwrap a plugin's default export across module formats.
 *
 * When you dynamic-`import()` a CommonJS module, Node sets the namespace's `default`
 * to the ENTIRE `module.exports`. Both the test fixtures (`module.exports.default = {…}`)
 * and the real tsup CJS bundle (`module.exports = { __esModule: true, default: <plugin> }`)
 * therefore surface as `ns.default = { default: <plugin>, … }` — i.e. a "double default".
 * So:
 *   - CJS double-default: `ns.default.default` is the plugin   (fixtures + tsup output)
 *   - pure ESM:           `ns.default` is the plugin directly   (no nested `default`)
 *   - bare module.exports: fall back to the namespace object itself
 */
function extractPlugin(mod: unknown): unknown {
  const m = mod as { default?: unknown } | null
  const d = m?.default
  if (d && typeof d === 'object' && 'default' in (d as object)) {
    return (d as { default: unknown }).default
  }
  return d ?? mod
}

/** Scans a plugins directory, dynamically imports each plugin's entry file, validates
 *  it against {@link PluginSchema}, and returns the valid plugins. Malformed or
 *  unimportable plugins are logged and skipped — one bad plugin never blocks the rest.
 *
 *  Each plugin lives in its own subdirectory (`<pluginsDir>/<name>/`) and exports a
 *  default `TimmyPlugin` from a bundled `dist/index.js` (preferred) or `index.js`. */
export const PluginLoader = {
  load: (pluginsDir: string): Effect.Effect<TimmyPlugin[]> =>
    Effect.gen(function* () {
      if (!existsSync(pluginsDir)) return []
      // existsSync(pluginsDir) is the fast path for the common missing-dir case, but it
      // returns true even when the path is a FILE (ENOTDIR) or an unreadable dir (EACCES),
      // in which cases readdirSync throws synchronously. A bare throw inside Effect.gen is
      // NOT caught by gen and would kill the boot fiber, so we wrap it in Effect.try and
      // degrade to an empty list — a boot-time loader must stay resilient.
      const dirs = yield* Effect.try({
        try: (): Dirent[] =>
          readdirSync(pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory()),
        catch: (e) => e,
      }).pipe(
        Effect.catchAll((e) =>
          Effect.logWarning(`plugins dir unreadable (${pluginsDir}): ${String(e)}`).pipe(
            Effect.as<Dirent[]>([]),
          ),
        ),
      )
      const loaded: TimmyPlugin[] = []
      const seenNames = new Set<string>()
      for (const d of dirs) {
        const base = join(pluginsDir, d.name)
        const entry = existsSync(join(base, 'dist', 'index.js'))
          ? join(base, 'dist', 'index.js')
          : join(base, 'index.js')
        if (!existsSync(entry)) {
          yield* Effect.logWarning(`plugin '${d.name}': no entry (index.js)`)
          continue
        }
        const mod = yield* Effect.tryPromise(() => import(pathToFileURL(entry).href)).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning(`plugin '${d.name}' import failed: ${String(e)}`).pipe(
              Effect.as(null),
            ),
          ),
        )
        if (mod === null) continue
        const candidate = extractPlugin(mod)
        const decoded = decodePlugin(candidate)
        if (decoded._tag === 'Left') {
          yield* Effect.logWarning(`plugin '${d.name}' invalid: ${decoded.left.message}`)
          continue
        }
        if (!decoded.right.tools.every((t) => typeof t.execute === 'function')) {
          yield* Effect.logWarning(`plugin '${d.name}': a tool has no execute()`)
          continue
        }
        const p = decoded.right
        // apiVersion gate: explicit-out-of-range → skip; missing → load with a deprecation
        // warning (so existing unversioned plugins keep working during migration).
        if (p.apiVersion === undefined) {
          yield* Effect.logWarning(
            `plugin '${d.name}': no apiVersion (legacy) — add 'apiVersion: PLUGIN_API_VERSION'; support for unversioned plugins may be removed`,
          )
        } else if (p.apiVersion < MIN_PLUGIN_API || p.apiVersion > CURRENT_PLUGIN_API) {
          yield* Effect.logWarning(
            `plugin '${d.name}': incompatible apiVersion ${p.apiVersion} (this Timmy supports ${MIN_PLUGIN_API}..${CURRENT_PLUGIN_API}) — rebuild against a matching timmy-sdk`,
          )
          continue
        }
        // A plugin must be internally consistent: reject duplicate tool names within it.
        if (new Set(p.tools.map((t) => t.name)).size !== p.tools.length) {
          yield* Effect.logWarning(`plugin '${d.name}': duplicate tool names — skipped`)
          continue
        }
        // Two installed plugins claiming the same name → keep the first (dir order), skip
        // the later (names prefix the credential + model-tool namespaces, so they must be unique).
        if (seenNames.has(p.name)) {
          yield* Effect.logWarning(
            `plugin '${d.name}': duplicate plugin name '${p.name}' — keeping the first, skipping this one`,
          )
          continue
        }
        seenNames.add(p.name)
        // execute is verified as a function above; Schema.Any can't express the function type, hence the cast.
        loaded.push(p as unknown as TimmyPlugin)
      }
      return loaded
    }),
}
