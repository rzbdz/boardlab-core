/**
 * What a module that is not part of boardlab's own build may use: the values a module needs to register itself and to
 * answer its endpoints, in one import, and the types the same names carry. It is bundled into a release (`dist/sdk.js`),
 * and a market module's `import 'boardlab'` resolves to it, so a market needs no `node_modules` on the machine.
 *
 * Values only at run time, and only ones the core already has: a module's `import type { … } from 'boardlab'` is erased
 * by Node. `src/sdk.ts` re-exports the same names with their types, for checking a module's TypeScript against.
 */
export { BoardError, BusyError, CancelledError } from './errors.ts'
export type { BoardErrorCode } from './errors.ts'
export { EventStream, FileReply, RawReply, TextReply } from './api.ts'
export type { Caller, ApiRequest, Emit, Endpoint } from './api.ts'
import type { PluginContext } from './module.ts'
export type { Dispose, PluginContext, PluginState } from './module.ts'

/**
 * A module as a market writes it: the same shape the core's own modules have, with the lab it is set up on typed. The
 * lab's extension points are what a module uses (`lab.markets.offer`, `lab.api.addOne`, `lab.addState`, `lab.kernel`);
 * nothing here narrows what those do.
 */
export type Module<Api = unknown> = Omit<import('./module.ts').Module<Api>, 'setup'> & {
  setup(lab: import('./lab.ts').BoardLab, ctx: PluginContext): Api
}
export type { BoardLab } from './lab.ts'
export type { ImageMarket, MarketFound, MarketImage, MarketKind, MarketSetup } from './markets.ts'
export type { Backend, LabConfig, LabDevice, LabSlots } from './backend.ts'
export type { LabKind } from './backends.ts'
export type { Settings } from './kernel.ts'
export type {
  Board, BoardDetail, LabSettings, Market, MarketEntry, MarketListing, MarketSearch, MarketTarget, State, Action, Lease,
} from '../shared/types.ts'

/** The version of this surface: bumped when its shape changes, so a module can refuse an older boardd. */
export const SDK = 1
