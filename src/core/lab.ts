/**
 * boardlab: the registry, gateway and interface of a set of flasher hosts. A BoardLab is the kernel and the core
 * subsystems every deployment has (locks, the inventory, backends, relay, consoles, download, files, proposals); what a
 * deployment can do beyond that, from the hardware on this machine to a remote lab, comes from the modules it loads.
 */
import type { Action, Lease, State } from '../shared/types.ts'
import { Api } from './api.ts'
import { Backends } from './backends.ts'
import { Boards } from './boards.ts'
import { Consoles, type ConsoleTiming } from './consoles.ts'
import { Download, type BootTiming } from './download.ts'
import { coreEndpoints } from './endpoints.ts'
import { Files } from './files.ts'
import { Kernel, type KernelOptions } from './kernel.ts'
import { Locks } from './locks.ts'
import type { Module, ModuleInfo } from './module.ts'
import { Proposals } from './proposals.ts'
import { Relay } from './relay.ts'

export interface BoardLabOptions extends KernelOptions {
  /** firmware/: firmware.json and the files it lists. */
  firmwareDir?: string
  /** Where files sent by remote CLIs are kept, by sha256. */
  filesDir?: string
  bootTiming?: Partial<BootTiming>
  consoleTiming?: Partial<ConsoleTiming>
  modules?: Module[]
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
  /** Every endpoint, the core's and the modules'; a gateway serves them. */
  readonly api = new Api()
  private readonly loaded = new Map<string, { module: Module, api: unknown }>()
  private readonly stateParts: Array<(you: string) => Partial<State>> = []
  private readonly historyParts: Array<(limit: number) => Record<string, unknown>> = []
  private readonly services: Service[] = []
  private stops: Array<() => void> = []

  constructor(options: BoardLabOptions) {
    this.kernel = new Kernel(options)
    this.events = this.kernel.events
    this.locks = new Locks(this.kernel)
    this.proposals = new Proposals(this.kernel)
    this.boards = new Boards(this)
    this.relay = new Relay(this)
    this.download = new Download(this, options.firmwareDir, options.bootTiming)
    this.files = new Files(this.kernel, options.filesDir)
    this.backends = new Backends(this)
    this.consoles = new Consoles(this, { watchIdleMs: 30_000, typingIdleMs: 60_000, watchLines: 2_000, ...options.consoleTiming })
    this.api.add('core', coreEndpoints(this))
    for (const module of inLoadOrder(options.modules ?? [])) this.use(module)
  }

  // ---------- modules ----------

  /** Set a module up; the modules it requires must be loaded already. Returns its API. */
  use<Api>(module: Module<Api>): Api {
    if (this.loaded.has(module.id)) throw new Error(`module ${module.id} is loaded twice`)
    const missing = (module.requires ?? []).filter(id => !this.loaded.has(id))
    if (missing.length) throw new Error(`module ${module.id} needs ${missing.join(', ')} loaded first`)
    const api = module.setup(this)
    this.loaded.set(module.id, { module: module as Module, api })
    return api
  }

  has(id: string): boolean { return this.loaded.has(id) }

  /** A loaded module's API. */
  module<Api>(id: string): Api {
    const entry = this.loaded.get(id)
    if (!entry) throw new Error(`module ${id} is not loaded`)
    return entry.api as Api
  }

  modules(): ModuleInfo[] { return [...this.loaded.values()].map(({ module }) => ({ id: module.id, title: module.title })) }

  /** Add to what `state` reports: a module's own part of the picture. */
  addState(part: (you: string) => Partial<State>) { this.stateParts.push(part) }
  addHistory(part: (limit: number) => Record<string, unknown>) { this.historyParts.push(part) }
  /** Run something while boardd runs (see `start`). */
  addService(service: Service) { this.services.push(service) }

  // ---------- the whole picture ----------

  state(you: string): State {
    const state: State = {
      boards: this.boards.list(), labs: this.backends.labSettings(), firmware: this.download.firmware(),
      proposals: this.proposals.pending(), modules: this.modules(), you, now: this.kernel.iso(), yields: this.locks.yieldsList(),
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
   * Start what runs while boardd runs: listing the backends' boards every minute (which also keeps their leases and news
   * streams alive), closing console sessions their viewers left, and every module's services.
   */
  start(options: { syncMs?: number, reapMs?: number } = {}) {
    void this.backends.syncAll()
    const sync = setInterval(() => void this.backends.syncAll(), options.syncMs ?? 60_000)
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
export function inLoadOrder(modules: Module[]): Module[] {
  const byId = new Map(modules.map(module => [module.id, module]))
  const out: Module[] = []
  const placed = new Set<string>(), visiting = new Set<string>()
  const place = (module: Module) => {
    if (placed.has(module.id)) return
    if (visiting.has(module.id)) throw new Error(`modules require each other in a cycle: ${[...visiting, module.id].join(' → ')}`)
    visiting.add(module.id)
    for (const id of module.requires ?? []) { const needed = byId.get(id); if (needed) place(needed) }
    visiting.delete(module.id)
    placed.add(module.id)
    out.push(module)
  }
  modules.forEach(place)
  return out
}
