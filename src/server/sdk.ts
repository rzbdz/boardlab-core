/**
 * How a module that is not in boardlab's build reaches boardlab: `import 'boardlab'` resolves to the SDK the running
 * boardd has (`dist/sdk.js`, built from `core/sdk.ts`), so a market module registers endpoints and replies with the same
 * classes the core does and `instanceof` holds across the boundary. A module's own files import each other relatively,
 * as any package does; only the bare `boardlab` name is redirected.
 *
 * The hook is process-wide and installed before the first market module is imported (see `main.ts`). A name boardlab does
 * not provide is refused with its name rather than loaded from a `node_modules` that happens to be on the machine: a
 * market module's dependencies are boardlab's surface, and nothing else resolves for it.
 */
import { registerHooks } from 'node:module'

/**
 * The names a module may import: the SDK itself, and the client library beside it (`boardlab/client`, what this package
 * exports as `./client`). Anything else is refused — a market module's dependencies are boardlab's surface.
 */
const IMPORTABLE = /^boardlab(\/(?:sdk|client))?$/

/**
 * Resolve `boardlab` and `boardlab/sdk` to the SDK at `sdk`, for every module. Installed once per process; a second call
 * changes what the name resolves to only if `sdk` differs.
 */
let current: string | null = null
/** The client library beside the SDK (`dist/client.js` for `dist/sdk.js`), as the package's `./client` export names it. */
const clientUrl = (sdk: string) => new URL('./client.js', sdk).href
export function resolveBoardlab(sdk: string): void {
  if (current === sdk) return
  if (!current) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (IMPORTABLE.test(specifier) && current) return { url: specifier === 'boardlab/client' ? clientUrl(current) : current, shortCircuit: true, format: 'module' }
        return nextResolve(specifier, context)
      },
    })
  }
  current = sdk
}
