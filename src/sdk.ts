/**
 * The package entry a module written outside boardlab imports: `import { BoardError } from 'boardlab'`. At run time
 * `boardd` resolves `boardlab` to its own built SDK (`dist/sdk.js`, from `core/sdk.ts`), so the classes are the ones the
 * core checks with `instanceof`; at build time this file gives a module's TypeScript the same values and types.
 *
 * A module's part of the page is built for the browser (`dist/sdk.browser.js`, see the distribution's `src/sdk.browser.ts`),
 * which exports the same helper names from `ui/contract.ts` and the page's own `call`.
 */
export * from './core/sdk.ts'
export { isRemoteGroup } from './shared/commands.ts'
export type { RemoteCommand, RemoteCommandGroup } from './shared/commands.ts'
export { parseDuration } from './shared/duration.ts'
