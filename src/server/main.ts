/** `boardlab serve`: build a BoardLab from boardd's configuration and the distribution's modules, and serve it. */
import { existsSync, mkdirSync } from 'node:fs'
import type { Socket } from 'node:net'
import { delimiter, join } from 'node:path'
import { DEFAULT_PORT, socketPathFor } from '../shared/client.ts'
import { openDatabase, scheduleBackups } from '../core/db.ts'
import { BoardLab } from '../core/lab.ts'
import { databaseSettings, moveAddedLabs } from '../core/renamed-kinds.ts'
import { createModules, type CatalogEntry } from './catalog.ts'
import { marketsOf, marketModules } from './markets.ts'
import { loadConfig, type BoarddConfig } from './config.ts'
import { describe, loadCommands } from '../cli/market-cli.ts'
import type { RemoteCommandGroup } from '../shared/commands.ts'
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

/** A boardd running: its lab, where it serves, and the handles its process (a supervisor's worker) needs. */
export interface Boardd {
  lab: BoardLab
  port: number
  uiDir: string | null
  config: BoarddConfig
  hosts: string[]
  accept(kind: 'http' | 'unix', socket: Socket): void
  connections(): number
  stopListening(): void
  closeIdle(): void
  endEvents(): void
  close(): Promise<void>
  /** Asks for a process that loads what the configuration says now; the CLI wires it under a supervisor. */
  reload?: (why: string) => void
}

export async function startBoardd(options: BoarddOptions): Promise<Boardd> {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
  // What the configuration may name: the modules this distribution has, and what its markets offer.
  const markets = marketsOf(options.stateDir)
  const fromMarket = new Set(markets.flatMap(market => market.modules.map(module => module.id)))
  // A module that renamed its id says so in its catalog entry: the configuration that still names it by the old one is
  // read as naming it now, and the labs someone added by the old name move before any kind is offered.
  const moves = Object.fromEntries(options.catalog.flatMap(entry => (entry.was ?? []).map(old => [old, entry.id])))
  // A configuration that names no modules takes the distribution's own, never a market's: a market is a shop, not a
  // load order, so installing one to browse it does not run its modules.
  const config = loadConfig(options.stateDir, options.config, options.catalog.map(entry => entry.id), moves)
  for (const [from, to] of Object.entries(config.renamed ?? {})) console.error(`boardd: 配置里的模块 ${from} 现在叫 ${to}（已在这次启动时照此加载；boardd.json 里的名字可以改了）`)
  const selection = options.modules ? Object.fromEntries(options.modules.map(id => [id, config.modules[id] ?? {}])) : config.modules
  if (Object.keys(moves).length) {
    const moved = openDatabase(join(options.stateDir, 'boards.sqlite'), { backups: join(options.stateDir, 'backups'), restore: !options.sharedDatabase })
    try { for (const move of moveAddedLabs(databaseSettings(moved), moves)) console.error(`boardd: lab ${move.id} is a ${move.to} now (was added as ${move.from})`) } finally { moved.close() }
  }
  // A module the configuration names that no market offers now (its market was removed, or updated away from it) is
  // said, not fatal: the rest of the boardd is what a person needs to see to fix it.
  for (const id of Object.keys(selection)) {
    if (!fromMarket.has(id) && !options.catalog.some(entry => entry.id === id)) console.error(`boardd: 配置里的模块 ${id} 没有：不在这个 boardlab 里，也不在已装的模块市场里（boardlab module search ${id}）`)
  }
  const known = Object.fromEntries(Object.entries(selection).filter(([id]) => !fromMarket.has(id) && options.catalog.some(entry => entry.id === id)))
  const builtIn = createModules(options.catalog, known, {
    stateDir: options.stateDir, shipped: options.shipped ?? (() => null), timing: config.timing,
    release: { version: options.version ?? 'dev', revision: options.revision ?? 'dev' },
    configFile: options.config ?? process.env.BOARDLAB_CONFIG ?? join(options.stateDir, 'boardd.json'),
  })
  // Modules the configuration takes from a market (see markets.ts). One that cannot be imported is said and left out,
  // never fatal: it is a package the machine's owner chose, and the rest of the lab — and the page that says what is
  // wrong with it — must still come up.
  for (const problem of markets.flatMap(market => market.problems)) console.error(`boardd: ${problem}`)
  const sdk = options.shipped?.('dist/sdk.js') ?? null
  const asked = Object.keys(selection).filter(id => fromMarket.has(id))
  // Without the SDK a market module cannot `import 'boardlab'`: each one asked for is said, rather than boardd not starting.
  if (asked.length && !sdk) for (const id of asked) console.error(`boardd: 模块加载不了，这次没有装它：${id}（这个 boardlab 没有带 dist/sdk.js，市场的模块要它才能 import 'boardlab'）`)
  const marketResult = sdk ? await marketModules(options.stateDir, selection, options.catalog.map(entry => entry.id), sdk) : { loaded: [], failed: [] }
  for (const { problem } of marketResult.failed) console.error(`boardd: 模块加载不了，这次没有装它：${problem}`)
  const fromMarkets = marketResult.loaded
  const modules = [...builtIn, ...fromMarkets.map(({ module }) => module)]
  for (const { module, settings } of fromMarkets) config.modules[module.id] = settings
  // A market module brings its own `boardlab` commands, as a file beside it: loaded here (where the module is), so a CLI
  // that does not have the module can list them and run one against this boardd (GET /api/cli/commands).
  const commandGroups: RemoteCommandGroup[] = []
  const commandFiles: string[] = []
  // The help pages those modules bring, under `<module>/<page>`: a view names one, and it answers as boardd's own do.
  const marketDocs: Array<{ name: string, title: string, file: string }> = []
  for (const { module } of fromMarkets) {
    const offered = markets.flatMap(market => market.modules).find(item => item.id === module.id)
    if (!offered) continue
    marketDocs.push(...offered.docs)
    if (!offered.cli) continue
    const { group, problem } = await loadCommands(offered.cli, module.id)
    if (problem) console.error(`boardd: ${module.id} 的命令加载不了：${problem}`)
    else if (group) { commandGroups.push(group); commandFiles.push(`${module.id}=${offered.cli}`) }
  }
  // Checked before it opens: a broken file is moved aside and the newest good copy from backups/ put in its place, by
  // a boardd that is the only one using it. One that shares it with another worker refuses to start instead.
  const file = join(options.stateDir, 'boards.sqlite'), backups = join(options.stateDir, 'backups')
  const db = openDatabase(file, { backups, restore: !options.sharedDatabase })
  const lab = new BoardLab({
    db, stateDir: options.stateDir, firmwareDir: options.firmwareDir, filesDir: join(options.stateDir, 'files'),
    bootTiming: config.timing.boot, consoleTiming: config.timing.console, modules, moduleMarkets: markets,
    settings: Object.fromEntries(fromMarkets.map(({ module, settings }) => [module.id, settings])),
    // The file a module that changes which modules load (the market's page) has to edit: the one this boardd read.
    configFile: config.source,
    release: { version: options.version ?? 'dev', revision: options.revision ?? 'dev' },
  })
  // A copy a little after start and every 6 hours, while this boardd (or worker) is the one serving: a worker an update
  // drained stops with the lab's other services, and a lock in backups/ keeps two workers from copying at once.
  lab.addService(() => scheduleBackups(db, file, backups))
  lab.start({ syncMs: config.timing.syncMs, reapMs: config.timing.reapMs })
  const port = options.port ?? DEFAULT_PORT
  // One frontend (index.html at the top), or several (frontends.json, see http.ts).
  const uiDir = options.uiDir && (existsSync(join(options.uiDir, 'index.html')) || existsSync(join(options.uiDir, 'frontends.json'))) ? options.uiDir : null
  const server = await serve(lab, { port, hosts: options.hosts, origins: options.origins, cli: options.cli, stateDir: options.stateDir, socketPath: socketPathFor(options.stateDir), uiDir, docsDir: options.shipped?.('docs/help') ?? null, version: options.version, revision: options.revision, ownSocket: !options.worker, handed: options.handed, observe: options.observe, sdkDir: options.shipped?.('dist') ?? null, marketCommands: async () => commandGroups.flatMap(describe), marketCli: commandFiles.join(delimiter), marketDocs: () => marketDocs })
  const address = server.http[0]?.address()
  // How this boardd asks for a new process of its own (a module installed or taken out): the CLI wires `reload` when it
  // runs as a worker under a supervisor.
  const handle: Boardd = {
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
  // Modules (the market's page) ask through the lab for a boardd that loads what its configuration says now.
  lab.reloader = why => handle.reload?.(why)
  return handle
}
