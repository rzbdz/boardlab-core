/**
 * The package entry a module written outside boardlab imports: `import { BoardError } from 'boardlab'`. At run time
 * `boardd` resolves `boardlab` to its own built SDK (`dist/sdk.js`, from `core/sdk.ts`), so the classes are the ones the
 * core checks with `instanceof`; at build time this file gives a module's TypeScript the same values and types.
 */
export * from './core/sdk.ts'
