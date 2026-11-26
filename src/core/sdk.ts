/**
 * What a module that is not part of boardlab's own build may use: the values a module needs to register itself and to
 * answer its endpoints, in one import, and the types the same names carry. It is bundled into a release (`dist/sdk.js`),
 * and a market module's `import 'boardlab'` resolves to it, so a market needs no `node_modules` on the machine. The same
 * file has a browser build (`dist/sdk.browser.js`) for a module's part of the page, which calls the API itself.
 *
 * Values only at run time, and only ones the core already has: a module's `import type { … } from 'boardlab'` is erased
 * by Node. `src/sdk.ts` re-exports the same names with their types, for checking a module's TypeScript against.
 */
import type { BoardLab } from './lab.ts'
import type { PluginContext } from './module.ts'

export { BoardError, BusyError, CancelledError } from './errors.ts'
export type { BoardErrorCode } from './errors.ts'
export { EventStream, FileReply, RawReply, TextReply } from './api.ts'
export type { Caller, ApiRequest, Emit, Endpoint } from './api.ts'
export type { Dispose, PluginContext, PluginState } from './module.ts'
export type { ImageMarket, MarketFound, MarketImage, MarketKind, MarketSetup } from './markets.ts'
export { JUMP } from './backend.ts'
export { isHuman, HOLDER, BOARD_NAME, str, stripAnsi } from './text.ts'
export type { Row } from './text.ts'
export type { Backend, BoardTarget, LabConfig, LabDevice, LabFinding, LabHolder, LabNews, LabSlots, Notice, RunReport } from './backend.ts'
export type { ConsoleSession, ConsoleHello } from './console.ts'
export type { LabKind } from './backends.ts'
export type { Settings } from './kernel.ts'

export type {
  Action, Board, BoardChannels, BoardDetail, LabField, LabFields, LabSettings, Lease, LockResult, Market, MarketEntry, MarketListing,
  MarketSearch, MarketTarget, Proposal, SendResult, State,
} from '../shared/types.ts'

/**
 * A module as a market writes it: the same shape the core's own modules have, with the lab it is set up on typed. Its
 * `ctx.config` is what boardd's configuration has for it.
 */
export interface Module<Api = unknown> {
  id: string
  title: string
  about?: string
  tags?: string[]
  requires?: string[]
  inject?: string[]
  provide?: string[]
  setup(lab: BoardLab, ctx: PluginContext): Api
}
