/**
 * What a module that is not part of boardlab's own build may use: the values a module needs to register itself and to
 * answer its endpoints, in one import. It is bundled into a release (`dist/sdk.js`), and a market module's
 * `import 'boardlab'` resolves to it, so a market needs no `node_modules` on the machine.
 *
 * Only values are here, and only ones the core already exports: types come from the package's own sources when a
 * module is written in TypeScript, and are erased at run time.
 */
export { BoardError, BusyError, CancelledError } from './errors.ts'
export type { BoardErrorCode } from './errors.ts'
export { EventStream, FileReply, RawReply, TextReply } from './api.ts'

/** The version of this surface: bumped when its shape changes, so a module can refuse an older boardd. */
export const SDK = 1
