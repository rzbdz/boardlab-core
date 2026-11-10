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
await build({ entryPoints: { cli, client: join(core, 'src/shared/client.ts') }, outdir: out, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24', sourcemap: true, banner: { js: '#!/usr/bin/env node' } })
await chmod(join(out, 'cli.js'), 0o755)
console.log(`Built the boardlab CLI and its client into ${out}.`)
