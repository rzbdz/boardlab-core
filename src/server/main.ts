/** `boardlab serve`: build a BoardLab from boardd's configuration and the distribution's modules, and serve it. */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PORT, socketPathFor } from '../shared/client.ts'
import { openDatabase, scheduleBackups } from '../core/db.ts'
import { BoardLab } from '../core/lab.ts'
import { databaseSettings, moveAddedLabs } from '../core/renamed-kinds.ts'
import { createModules, type CatalogEntry } from './catalog.ts'
import { marketsOf, marketModules } from './markets.ts'
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
  /** This release's version and revision, for `GET /api/version`. */
  version?: string
  revision?: string
  /** One worker under a supervisor: it shares the Unix socket with the other workers. */
  worker?: boolean
  /**
   * Another boardd (an older worker) still has the database open: a damaged file is left to it, and this one refuses
   * to start rather than restore a copy under it (see supervisor.ts, SHARED_DATABASE_ENV).
   */
  sharedDatabase?: boolean
  /** Listen on nothing: a supervisor owns the port and the socket and hands connections over (`accept`). */
  handed?: boolean
  /** Told of each request's method and path (see ServeOptions.observe). */
  observe?: (method: string, path: string) => void
}

export async function startBoardd(options: BoarddOptions) {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
  const config = loadConfig(options.stateDir, options.config, options.catalog.map(entry => entry.id))
  const selection = options.modules ? Object.fromEntries(options.modules.map(id => [id, config.modules[id] ?? {}])) : config.modules
  // A module that renamed its id moves the labs someone added by the old name before any kind is offered.
  const moves = Object.fromEntries(options.catalog.flatMap(entry => (entry.was ?? []).map(old => [old, entry.id])))
  if (Object.keys(moves).length) {
    const moved = openDatabase(join(options.stateDir, 'boards.sqlite'), { backups: join(options.stateDir, 'backups'), restore: !options.sharedDatabase })
    try { for (const move of moveAddedLabs(databaseSettings(moved), moves)) console.error(`boardd: lab ${move.id} is a ${move.to} now (was added as ${move.from})`) } finally { moved.close() }
  }
  const builtIn = createModules(options.catalog, selection, {
    stateDir: options.stateDir, shipped: options.shipped ?? (() => null), timing: config.timing,
    release: { version: options.version ?? 'dev', revision: options.revision ?? 'dev' },
  })
  // Modules the configuration takes from a market (see markets.ts): imported before the lab exists, so one that cannot
  // be imported stops boardd from starting rather than leaving a half-loaded lab behind.
  const markets = marketsOf(options.stateDir)
  for (const problem of markets.flatMap(market => market.problems.map(issue => `${issue}`))) console.error(`boardd: ${problem}`)
  const fromMarkets = await marketModules(options.stateDir, selection, options.catalog.map(entry => entry.id))
  const modules = [...builtIn, ...fromMarkets.map(({ module }) => module)]
  for (const { module, settings } of fromMarkets) config.modules[module.id] = settings
  // Checked before it opens: a broken file is moved aside and the newest good copy from backups/ put in its place, by
  // a boardd that is the only one using it. One that shares it with another worker refuses to start instead.
  const file = join(options.stateDir, 'boards.sqlite'), backups = join(options.stateDir, 'backups')
  const db = openDatabase(file, { backups, restore: !options.sharedDatabase })
  const lab = new BoardLab({
    db, firmwareDir: options.firmwareDir, filesDir: join(options.stateDir, 'files'),
    bootTiming: config.timing.boot, consoleTiming: config.timing.console, modules, moduleMarkets: markets,
  })
  // A copy a little after start and every 6 hours, while this boardd (or worker) is the one serving: a worker an update
  // drained stops with the lab's other services, and a lock in backups/ keeps two workers from copying at once.
  lab.addService(() => scheduleBackups(db, file, backups))
  lab.start({ syncMs: config.timing.syncMs, reapMs: config.timing.reapMs })
  const port = options.port ?? DEFAULT_PORT
  // One frontend (index.html at the top), or several (frontends.json, see http.ts).
  const uiDir = options.uiDir && (existsSync(join(options.uiDir, 'index.html')) || existsSync(join(options.uiDir, 'frontends.json'))) ? options.uiDir : null
  const server = await serve(lab, { port, hosts: options.hosts, origins: options.origins, cli: options.cli, stateDir: options.stateDir, socketPath: socketPathFor(options.stateDir), uiDir, docsDir: options.shipped?.('docs/help') ?? null, version: options.version, revision: options.revision, ownSocket: !options.worker, handed: options.handed, observe: options.observe })
  const address = server.http[0]?.address()
  return {
    lab, port: address && typeof address === 'object' ? address.port : port, uiDir, config, hosts: ['127.0.0.1', ...(options.hosts ?? [])],
    accept: server.accept, connections: server.connections, stopListening: server.stopListening, closeIdle: server.closeIdle, endEvents: server.endEvents,
    async close() {
      lab.stop()
      // Viewers are told boardd is restarting rather than seeing their streams cut; the events go out before the sockets.
      lab.consoles.shutdown('服务重启')
      await new Promise(resolve => setTimeout(resolve, 50))
      await server.close(); db.close()
    },
  }
}
