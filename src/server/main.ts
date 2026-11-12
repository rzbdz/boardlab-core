/** `boardlab serve`: build a BoardLab from boardd's configuration and the distribution's modules, and serve it. */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PORT, socketPathFor } from '../shared/client.ts'
import { openDatabase } from '../core/db.ts'
import { BoardLab } from '../core/lab.ts'
import { createModules, type CatalogEntry } from './catalog.ts'
import { loadConfig } from './config.ts'
import { serve } from './http.ts'

export interface BoarddOptions {
  stateDir: string
  /** The modules this distribution offers. */
  catalog: CatalogEntry[]
  /** Where files shipped with the distribution are (see ModuleContext.shipped). */
  shipped?: (path: string) => string | null
  port?: number
  hosts?: string[]
  origins?: string[]
  /** The UI to serve; null for none (an API-only boardd). */
  uiDir?: string | null
  firmwareDir?: string
  cli?: string
  /** boardd's configuration file (see config.ts). */
  config?: string
  /** Load these modules (with their settings from the configuration) instead of the configuration's list. */
  modules?: string[]
}

export async function startBoardd(options: BoarddOptions) {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
  const config = loadConfig(options.stateDir, options.config, options.catalog.map(entry => entry.id))
  const selection = options.modules ? Object.fromEntries(options.modules.map(id => [id, config.modules[id] ?? {}])) : config.modules
  const modules = createModules(options.catalog, selection, {
    stateDir: options.stateDir, shipped: options.shipped ?? (() => null), timing: config.timing,
  })
  const db = openDatabase(join(options.stateDir, 'boards.sqlite'))
  const lab = new BoardLab({
    db, firmwareDir: options.firmwareDir, filesDir: join(options.stateDir, 'files'),
    bootTiming: config.timing.boot, consoleTiming: config.timing.console, modules,
  })
  lab.start({ syncMs: config.timing.syncMs, reapMs: config.timing.reapMs })
  const port = options.port ?? DEFAULT_PORT
  // One frontend (index.html at the top), or several (frontends.json, see http.ts).
  const uiDir = options.uiDir && (existsSync(join(options.uiDir, 'index.html')) || existsSync(join(options.uiDir, 'frontends.json'))) ? options.uiDir : null
  const server = await serve(lab, { port, hosts: options.hosts, origins: options.origins, cli: options.cli, stateDir: options.stateDir, socketPath: socketPathFor(options.stateDir), uiDir, docsDir: options.shipped?.('docs/help') ?? null })
  return {
    lab, port, uiDir, config, hosts: ['127.0.0.1', ...(options.hosts ?? [])],
    async close() { lab.stop(); await server.close(); db.close() },
  }
}
