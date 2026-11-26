/**
 * A boardlab module: one piece of what boardd can do, plugged in at start. A module sets itself up on the lab through
 * its extension points (backends, lock targets and followers, board views, proposal owners, state, endpoints,
 * services) and may hand other modules an API of its own.
 *
 * The type lives in `plugin.ts`, next to the loader that runs it; this file stays where modules have always imported
 * it from.
 */
import type { BoardLab } from './lab.ts'
import type { Module as PluginModule, PluginContext } from './plugin.ts'

export interface Module<Api = unknown> extends Omit<PluginModule<Api>, 'setup'> {
  setup(lab: BoardLab, ctx: PluginContext): Api
}

export type { ModuleInfo } from '../shared/types.ts'
export { Loader, type Dispose, type PluginContext, type PluginState } from './plugin.ts'
