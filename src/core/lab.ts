/**
 * boardlab: the registry, gateway and interface of a set of flasher hosts. A BoardLab is the kernel and the core
 * subsystems every deployment has (locks, the inventory, backends, relay, consoles, download, files, proposals); what a
 * deployment can do beyond that, from the hardware on this machine to a remote lab, comes from the modules it loads.
 */
import { basename } from 'node:path'
import type { Action, Firmware, Lease, State } from '../shared/types.ts'
import { Api, type Endpoint } from './api.ts'
import { Backends } from './backends.ts'
import { BoardError } from './errors.ts'
import { Boards } from './boards.ts'
import { Consoles, type ConsoleTiming } from './consoles.ts'
import { Download, type BootTiming } from './download.ts'
import { acknowledgeRestore, restoreRecord } from './db.ts'
import { debugEndpoints } from './debug-endpoints.ts'
import { marketEndpoints } from './market-endpoints.ts'
import { moduleMarketEndpoints } from './module-market-endpoints.ts'
import { coreEndpoints } from './endpoints.ts'
import { Files } from './files.ts'
import { Kernel, type KernelOptions } from './kernel.ts'
import { resumeRuns } from './resume.ts'
import { Locks } from './locks.ts'
import { Markets } from './markets.ts'
import type { Module, ModuleInfo } from './module.ts'
import type { ModuleMarket } from './module-markets.ts'
import { Loader, type Dispose, type PluginState } from './plugin.ts'
import { registryOf } from './plugin-registry.ts'
import { Proposals } from './proposals.ts'
import { Relay } from './relay.ts'
import { isHuman } from './text.ts'

export interface BoardLabOptions extends KernelOptions {
  /** Where boardd keeps what outlives a run; modules get it as `ctx.stateDir`. */
  stateDir?: string
  /** firmware/: firmware.json and the files it lists (a release's; a module adds its own at start). */
  firmwareDir?: string
  /** Where files sent by remote CLIs are kept, by sha256. */
  filesDir?: string
  bootTiming?: Partial<BootTiming>
  consoleTiming?: Partial<ConsoleTiming>
  /** Distribution-owned product knowledge; core does not infer SoCs from model names. */
  socFromProduct?: (product: string) => string | null
  modules?: Module[]
  /** The module markets this boardd was started with, as their copies describe them (see `module-markets.ts`). */
  moduleMarkets?: ModuleMarket[]
  /** The release boardd serves, for a module's context (`PluginContext.release`). */
  release?: { version: string, revision: string }
  /** A file shipped with that release, for a module's context (`PluginContext.shipped`). */
  shipped?: (path: string) => string | null
  /** boardd's timing settings, for a module's context (`PluginContext.timing`). */
  timing?: Record<string, unknown>
  /** Its own configuration file, for a module that changes which modules boardd loads (the market's page). */
  configFile?: string | null
  /** Each module's settings, by id (what its catalog entry, or its market, was made with). */
  settings?: Record<string, Record<string, unknown>>
}

/** A running piece of a module (a timer, a stream): started with boardd, stopped with it. */
export type Service = () => (() => void) | void

export class BoardLab {
  readonly kernel: Kernel
  readonly events: Kernel['events']
  readonly locks: Locks
  readonly proposals: Proposals
  readonly boards: Boards
  readonly relay: Relay
  readonly download: Download
  readonly files: Files
  readonly backends: Backends
  readonly consoles: Consoles
  readonly markets: Markets
  /** The module markets boardd was started with: what they offer, and which modules came from one. */
  readonly moduleMarkets: ModuleMarket[]
  /** Every endpoint, the core's and the modules'; a gateway serves them. */
  readonly api = new Api()
  /** The plugin runtime: what a module registers, and how to take it back. */
  readonly loader: Loader
  /**
   * Set by boardd when it runs under a supervisor: asks for a new process that loads what the configuration says now
   * (a module installed or taken out). Undefined when there is none — a boardd on its own restarts when its operator
   * says, and a module that needs one has to say so rather than pretend.
   */
  reloader?: (why: string) => void
  private readonly stateParts: Array<(you: string) => Record<string, unknown>> = []
  private readonly historyParts: Array<(limit: number) => Record<string, unknown>> = []
  private readonly services: Service[] = []
  private stops: Array<() => void> = []

  constructor(options: BoardLabOptions) {
    // The plugin runtime comes first: every subsystem below registers extension points that record with it.
    this.loader = new Loader({
      lab: this,
      stateDir: options.stateDir ?? '',
      registry: registryOf(this),
      configFile: options.configFile ?? null,
      ...(options.release ? { release: options.release } : {}),
      ...(options.shipped ? { shipped: options.shipped } : {}),
      ...(options.timing ? { timing: options.timing } : {}),
      log: (id, line) => console.error(`[${id}] ${line}`),
      report: (id, error) => console.error(`[${id}] ${(error as Error)?.stack ?? error}`),
    })
    this.kernel = new Kernel(options)
    this.events = this.kernel.events
    this.locks = new Locks(this.kernel)
    this.proposals = new Proposals(this.kernel)
    this.boards = new Boards(this, options.socFromProduct)
    this.relay = new Relay(this)
    this.download = new Download(this, options.firmwareDir, options.bootTiming)
    this.files = new Files(this.kernel, options.filesDir)
    this.backends = new Backends(this)
    this.consoles = new Consoles(this, options.consoleTiming)
    this.markets = new Markets(this.kernel)
    this.moduleMarkets = options.moduleMarkets ?? []
    this.api.add('core', [...coreEndpoints(this), ...debugEndpoints(this), ...marketEndpoints(this), ...moduleMarketEndpoints(this), ...databaseEndpoints(this)])
    this.kernel.recordUndo = undo => this.loader.record(undo)
    this.api.track(undo => this.loader.record(undo))
    for (const module of inLoadOrder(options.modules ?? [])) this.use(module, options.settings?.[module.id] ?? {}, { tolerate: this.fromMarket(module.id) })
  }

  // ---------- modules ----------

  /**
   * Set a module up; the modules it requires must be loaded already. Returns its API. Everything it registers goes
   * through the plugin context it is given, so it can be taken down again (`Loader.remove`).
   *
   * A setup that throws leaves nothing behind and the error goes on: a module this lab was built with not starting is
   * the start's failure. A module from a market passes `tolerate` and is only reported, so one bad third-party module
   * does not keep the lab from running.
   */
  use<Api>(module: Module<Api>, config: Record<string, unknown> = {}, options: { tolerate?: boolean } = {}): Api {
    if (this.loader.has(module.id)) throw new Error(`module ${module.id} is loaded twice`)
    // `requires` names modules (set up here, in this order); `inject` names services (provided by whichever module
    // offers them). A missing one is refused now: boardd lists its modules in an order, so this is a bug in that list.
    // A third-party module (`tolerate`) waits instead — the loader reports it pending and says what it waits for —
    // and so does one added later through the loader.
    const missing = [...(module.requires ?? []).filter(id => !this.loader.has(id)), ...(module.inject ?? []).filter(name => !this.loader.services.has(name))]
    if (missing.length && !options.tolerate) throw new Error(`module ${module.id} needs ${missing.join(', ')} loaded first`)
    const api = this.loader.add(module, config)
    if (!options.tolerate) {
      const state = this.loader.list().find(item => item.id === module.id)
      if (state?.status === 'failed') throw new Error(`module ${module.id}: ${state.why}`)
    }
    return api as Api
  }

  has(id: string): boolean { return this.loader.has(id) }

  /** Whether a module came from a market rather than this distribution's own build: a failed third-party one is reported, not fatal. */
  fromMarket(id: string): boolean { return this.moduleMarkets.some(market => market.modules.some(module => module.id === id)) }

  /** A service a module provides (its API is one, under its id). */
  service<Api>(id: string): Api { return this.loader.service<Api>(id) }

  /** A loaded module's API. */
  module<Api>(id: string): Api { return this.loader.api<Api>(id) }

  modules(): ModuleInfo[] { return this.loader.list().filter(state => state.status === 'active').map(state => ({ id: state.id, title: state.title })) }
  /** What every module is and whether it runs (a pending one says which service it waits for). */
  plugins(): PluginState[] { return this.loader.list() }

  /** Record an undo with the module being set up now, if any: a direct `lab.…` registration in a module's setup. */
  track(undo: Dispose) { this.loader.record(undo) }

  // ---------- what modules add ----------

  /** Add to what `state` reports: a module's own part of the picture. */
  addState(part: (you: string) => Record<string, unknown>) { this.stateParts.push(part); this.track(() => this.removeState(part)) }
  removeState(part: (you: string) => Record<string, unknown>) { this.drop(this.stateParts, part) }
  addHistory(part: (limit: number) => Record<string, unknown>) { this.historyParts.push(part); this.track(() => this.removeHistory(part)) }
  removeHistory(part: (limit: number) => Record<string, unknown>) { this.drop(this.historyParts, part) }
  /**
   * Add firmware the lab can load (`stage`/`boot` by name), on top of what the release ships: a vendor's modules bring
   * their own files, so the core names no SoC's. Returns the way to take them back (a module's setup tracks it).
   */
  addFirmware(images: Firmware[]): Dispose {
    const drop = this.download.addFirmware(images)
    this.track(drop)
    return drop
  }

  /** Run something while boardd runs (see `start`). */
  addService(service: Service) { this.services.push(service); this.track(() => this.removeService(service)) }
  removeService(service: Service) { this.drop(this.services, service) }
  private drop<T>(list: T[], item: T) { const at = list.indexOf(item); if (at >= 0) list.splice(at, 1) }

  // ---------- the whole picture ----------

  state(you: string): State {
    const state: State = {
      boards: this.boards.list(), labs: this.backends.labSettings(), firmware: this.download.firmware(),
      proposals: this.proposals.pending(), modules: this.modules(), plugins: this.plugins(), you, now: this.kernel.iso(), yields: this.locks.yieldsList(you),
      restored: restoreRecord(this.kernel.db), markets: this.markets.list(),
    }
    for (const part of this.stateParts) Object.assign(state, part(you))
    return state
  }

  history(limit = 200): { actions: Action[], leases: Lease[] } & Record<string, unknown> {
    const history: { actions: Action[], leases: Lease[] } & Record<string, unknown> = { actions: this.boards.actions(limit), leases: this.boards.leases(limit) }
    for (const part of this.historyParts) Object.assign(history, part(limit))
    return history
  }

  // ---------- running ----------

  /**
   * Start what runs while boardd runs: taking over the runs a previous boardd left (`resumeRuns`), listing the backends' boards every minute (which also keeps their leases and news
   * streams alive), closing console sessions their viewers left, and every module's services.
   */
  start(options: { syncMs?: number, reapMs?: number } = {}) {
    void this.backends.syncAll()
    // Runs a previous boardd left running are followed again or marked interrupted, now and at each sync (a worker
    // being replaced finishes its own, unless it dies first).
    resumeRuns(this)
    const sync = setInterval(() => { void this.backends.syncAll(); resumeRuns(this) }, options.syncMs ?? 60_000)
    const reap = setInterval(() => this.consoles.reap(), options.reapMs ?? 30_000)
    sync.unref()
    reap.unref()
    this.stops = [() => clearInterval(sync), () => clearInterval(reap), () => this.backends.stopFollowing()]
    for (const service of this.services) {
      const stop = service()
      if (stop) this.stops.push(stop)
    }
  }

  stop() {
    for (const stop of this.stops.reverse()) stop()
    this.stops = []
  }
}

/**
 * Modules in an order that sets each up after the ones it requires, otherwise as given: a distribution lists its
 * modules in any order. A module requiring one that is not there is left for `use` to refuse.
 */
/**
 * boardd's database, as people see it: a restore it made at a start stays in the state until a person says they saw it.
 * Agents read it, but only a person acknowledges it: what was lost is theirs to check.
 */
function databaseEndpoints(lab: BoardLab): Endpoint[] {
  return [
    { method: 'GET', path: '/api/database', about: '数据库的情况：启动时从备份恢复过、还没人确认的那次（restored）', handle: () => ({ restored: restoreRecord(lab.kernel.db) }) },
    {
      method: 'POST', path: '/api/database/acknowledge', about: '确认看到了数据库从备份恢复（只有人可以）；之后状态里不再报', handle: ({ caller }) => {
        if (!isHuman(caller.holder)) throw new BoardError('forbidden', '数据库恢复要人来确认：丢了哪些改动，得人去核对')
        const record = acknowledgeRestore(lab.kernel.db)
        if (record) { lab.kernel.record(caller.holder, null, 'db-restore-ack', record.backup ? basename(record.backup) : null, true, null); lab.kernel.changed(null) }
        return { acknowledged: record }
      },
    },
  ]
}

export function inLoadOrder(modules: Module[]): Module[] {
  const byId = new Map(modules.map(module => [module.id, module]))
  const out: Module[] = []
  const placed = new Set<string>(), visiting = new Set<string>()
  // `inject` names a service, not a module: whichever module offers it goes first. A module from a market may inject
  // one a built-in provides, and its position in the list is up to whoever installed it.
  const providers = new Map<string, Module>()
  // A module's API is offered under its own id (see `Loader.setup`), so that name needs no `provide` entry.
  for (const module of modules) { if (!providers.has(module.id)) providers.set(module.id, module); for (const name of module.provide ?? []) if (!providers.has(name)) providers.set(name, module) }
  const place = (module: Module) => {
    if (placed.has(module.id)) return
    if (visiting.has(module.id)) throw new Error(`modules require each other in a cycle: ${[...visiting, module.id].join(' → ')}`)
    visiting.add(module.id)
    for (const id of module.requires ?? []) { const needed = byId.get(id); if (needed) place(needed) }
    for (const name of module.inject ?? []) { const provider = providers.get(name); if (provider && provider !== module) place(provider) }
    visiting.delete(module.id)
    placed.add(module.id)
    out.push(module)
  }
  modules.forEach(place)
  return out
}
