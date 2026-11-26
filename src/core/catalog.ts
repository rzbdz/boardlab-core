/**
 * How a distribution offers its modules to boardd: what making one may need from the machine boardd runs on, and what
 * an entry declares. In `core` because a module from a market is described by the same shape a built-in one is — the
 * SDK hands out these types — and both sides must agree on it.
 */
import type { Module } from './module.ts'
import type { ModuleSettings as Settings } from '../shared/settings.ts'

/** What making a module may need from the machine boardd runs on. */
export interface ModuleContext {
  stateDir: string
  /** A file shipped with this distribution (a bundled tool's binary, a site's tree), or null. */
  shipped(path: string): string | null
  /** boardd's timing settings (`timing` in its configuration), for modules that take some. */
  timing: Record<string, unknown>
  /** The distribution release boardd is serving. */
  release: { version: string, revision: string }
  /** boardd's configuration file, for a module that changes which modules boardd loads (the market's page). */
  configFile?: string | null
}

export interface CatalogEntry {
  id: string
  about: string
  /**
   * The ids this module had before, oldest last. A lab someone added by an old id keeps working: boardd moves the
   * stored kind to `id` before it offers any kind. Only the ids a stored `labs.added` can hold belong here.
   */
  was?: string[]
  create(settings: Settings, context: ModuleContext): Module
}
