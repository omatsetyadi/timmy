/**
 * Build the standalone `timmy` binary with Bun (`bun build-binary.ts [outfile]`).
 *
 * Why a script and not `bun build --compile` on the CLI: we need a bundler plugin to **stub
 * `react-devtools-core`**. Ink imports it only behind `if (process.env.DEV) … import('./devtools.js')`
 * — opt-in, and we don't install it — so it's never loaded in production. But Bun's bundler still
 * tries to resolve it and fails ("Could not resolve react-devtools-core"). Stubbing it with an empty
 * module lets the bundle succeed; the stub is never executed (DEV is unset in the shipped binary).
 *
 * The chat TUI (Ink, ESM) is bundled in via `chat()`'s `import('./chat-tui/app.tsx')` under Bun.
 */
const outfile = process.argv[2] ?? 'timmy'

const result = await Bun.build({
  entrypoints: ['src/index.ts'],
  compile: { outfile },
  plugins: [
    {
      name: 'stub-react-devtools-core',
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: 'react-devtools-core',
          namespace: 'stub-rdc',
        }))
        build.onLoad({ filter: /.*/, namespace: 'stub-rdc' }, () => ({
          contents: 'export default {}',
          loader: 'js',
        }))
      },
    },
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(`built ${outfile}`)
