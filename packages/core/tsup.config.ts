import { defineConfig } from 'tsup'

/** Bundles the Ink TUI subtree to an ESM .mjs. Ink/React are ESM-only (yoga-layout has top-level
 *  await) so the CJS app loads this via dynamic import(); externalizing them keeps them as runtime
 *  ESM imports. Output co-located in dist so the built cli.js can `import('./chat-tui/app.mjs')`. */
export default defineConfig({
  entry: { 'infra/chat-tui/app': 'src/infra/chat-tui/app.tsx' },
  outDir: 'dist',
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  external: ['react', 'ink', 'ink-text-input'],
  target: 'node24',
  dts: false,
  clean: false, // tsc emits the rest of dist; do not wipe it
  splitting: false,
})
