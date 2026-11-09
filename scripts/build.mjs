/**
 * Build a boardlab distribution into dist/: its CLI (which also runs boardd), the client library, and the default page.
 *
 *   node <core>/scripts/build.mjs [--cli src/boardlab.ts] [--page src/page.tsx] [--out dist]
 *
 * Entries are the distribution's (relative to where it runs); the page's static files come from the core.
 */
import { build } from 'esbuild'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback }
const out = resolve(option('out', 'dist'))
const cli = option('cli', join(core, 'bare/boardlab.ts'))
const page = option('page', join(core, 'bare/page.tsx'))

await mkdir(join(out, 'ui'), { recursive: true })
await build({ entryPoints: { cli, client: join(core, 'src/shared/client.ts') }, outdir: out, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24', sourcemap: true, banner: { js: '#!/usr/bin/env node' } })
await chmod(join(out, 'cli.js'), 0o755)
await build({ entryPoints: [page], outfile: join(out, 'ui/main.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, sourcemap: true, define: { 'process.env.NODE_ENV': '"production"' } })
for (const file of ['index.html', 'styles.css']) await copyFile(join(core, 'src/ui', file), join(out, 'ui', file))
const require = createRequire(join(process.cwd(), 'package.json'))
await copyFile(require.resolve('@xterm/xterm/css/xterm.css', { paths: [process.cwd(), core] }), join(out, 'ui/xterm.css'))
console.log(`Built the boardlab CLI, its client and the page into ${out}.`)
