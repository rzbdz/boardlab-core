/**
 * Build a boardlab distribution's CLI (which also runs boardd) and the client library into dist/.
 *
 *   node <core>/scripts/build.mjs [--cli src/boardlab.ts] [--out dist]
 *
 * The core has no page: a distribution builds its frontends itself into dist/ui (one frontend, or several listed in
 * dist/ui/frontends.json), which `boardlab serve` serves.
 */
import { build } from 'esbuild'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback }
const out = resolve(option('out', 'dist'))
const cli = option('cli', join(core, 'bare/boardlab.ts'))

await mkdir(out, { recursive: true })
// `cli` (with boardd) and the client library, plus the SDK a market module imports as `boardlab`. The SDK is its own
// entry so it shares its chunks with the CLI: a module's `new BoardError(...)` is the class boardd itself checks.
await build({ entryPoints: { cli, client: join(core, 'src/shared/client.ts'), sdk: join(core, 'src/core/sdk.ts') }, outdir: out, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24', sourcemap: true, banner: {
  // CommonJS dependencies bundled into ES modules still call require(): give every file one.
  // `--no-warnings`: node's SQLite is experimental and every run would print its warning before anything else a
  // person or a program asked for. The program says what it needs to; nothing is hidden that a user acts on.
  js: "#!/usr/bin/env -S node --no-warnings\nimport { createRequire as __boardlabCreateRequire } from 'node:module'; const require = __boardlabCreateRequire(import.meta.url);",
} })
await chmod(join(out, 'cli.js'), 0o755)
console.log(`Built the boardlab CLI and its client into ${out}.`)
