/**
 * A boardlab module: one piece of what boardd can do, plugged in at start. A module sets itself up on the lab through
 * its extension points (backends, lock targets and followers, board views, proposal owners, state, endpoints, services)
 * and may hand other modules an API of its own.
 */
import type { BoardLab } from './lab.ts'

export interface Module<Api = unknown> {
  /** Short and stable: other modules name it in `requires`, configuration in its module list. */
  id: string
  title: string
  /** Modules that must be set up first. */
  requires?: string[]
  setup(lab: BoardLab): Api
}

export type { ModuleInfo } from '../shared/types.ts'
