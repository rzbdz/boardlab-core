/**
 * The plugin runtime: what a module is, and what happens when it is set up and taken down.
 *
 * A module is one thing — a set of callbacks on the lab's extension points — and nothing more. A module that adds
 * nothing but data (a set of build recipes, a list of hosts) and one that adds a whole backend have the same shape: a
 * function that receives the lab and a context, and registers through that context. What tells them apart is `tags`,
 * for people and for a market's search; nothing in the runtime acts on it.
 *
 * Two rules make a plugin safe to add and to remove:
 *
 * - **Every side effect is undoable.** A registration that goes through the context (`ctx.effect`, `ctx.on`,
 *   `ctx.provide`, and the `ctx.*` registration helpers) keeps how to undo it. Taking a plugin down runs those in
 *   reverse, so its endpoints, views, subscriptions, timers and child processes go with it.
 * - **What it needs is declared, not assumed.** `inject` names the services a plugin needs. Boardd sets a plugin up
 *   only when they are all provided and reports it pending until then; when one goes away, the plugins that injected
 *   it are taken down first, then the one that provided it.
 *
 * The shape is cordis's effect/coeffect split (arXiv:2608.25512), kept to the part boardlab needs: no proxies, no
 * lookup by call stack, no hot module replacement. A service is a value a module holds; a restart is a stop and a
 * start.
 */

/** Undo one registration. Running one twice does nothing the second time. */
export type Dispose = () => void | Promise<void>

/** What a module's setup is given besides the lab. */
export interface PluginContext {
  /** The module's id. */
  readonly id: string
  /** The settings of its entry in boardd's `modules` map, as its catalog entry (or its market) made them. */
  readonly config: Record<string, unknown>
  /** boardd's state directory: where it keeps what outlives a run (its database, files, its own keys). */
  readonly stateDir: string
  /** Register a side effect, and the way to undo it (returned by what you register, or returned here). */
  effect(run: () => Dispose | void): Dispose
  /** Listen to an event of the lab; the listener is removed when the plugin is taken down. */
  on(event: string, listener: (payload: unknown) => void): Dispose
  /** Offer a service by name; other modules reach it with `lab.service(name)`. */
  provide<T>(name: string, service: T): T
  /** A service another plugin provides — by convention its API under its id. */
  service<T>(name: string): T
  /** A line in boardd's log, with the module's id in front. */
  log(line: string): void
}

/** A module as boardd loads it: what a catalog entry makes, with its settings already applied. */
export interface Module<Api = unknown> {
  /** Short and stable: other modules name it in `requires`/`inject`, configuration in its module list. */
  id: string
  title: string
  /** One line on what it is, for `boardlab module list`. */
  about?: string
  /** For search: `content`, `backend`, `own`, a vendor's name… Free text, nothing acts on it. */
  tags?: string[]
  /** Modules that must be set up first, by id. Kept for modules written before `inject`. */
  requires?: string[]
  /** Services it needs before it can be set up (a module's API is its id). */
  inject?: string[]
  /** Services it offers, besides its own API (the same as `ctx.provide` inside `setup`). */
  provide?: string[]
  setup(lab: unknown, ctx: PluginContext): Api
}

/** One module the loader was given, and whether it runs. */
export interface PluginState {
  id: string
  title: string
  about: string
  tags: string[]
  inject: string[]
  provide: string[]
  status: 'active' | 'pending' | 'failed' | 'stopped'
  /** Why it is not active: a service nobody offers, or what went wrong setting it up. */
  why: string | null
}

interface Entry {
  module: Module
  ctx: Context
  api: unknown
  status: PluginState['status']
  why: string | null
}

/** The lab's extension points, as the loader registers and unregisters them. */
export interface Registry {
  endpoint(module: string, endpoint: unknown): Dispose
  view(view: unknown): Dispose
  lockTarget(exists: (target: string) => boolean): Dispose
  lockOccupant(occupant: (target: string) => string | null): Dispose
  lockFollower(follower: unknown): Dispose
  state(part: (you: string) => Record<string, unknown>): Dispose
  history(part: (limit: number) => Record<string, unknown>): Dispose
  service(service: () => Dispose | void): Dispose
  backend(id: string, backend: unknown, options?: { configurable?: boolean, isDefault?: boolean, kind?: string }): Dispose
  labKind(kind: unknown): Dispose
  event(event: string, listener: (payload: unknown) => void): Dispose
}

class Context implements PluginContext {
  readonly undo: Dispose[] = []
  /** The service names this module offered, so they are freed with it. */
  readonly provided: string[] = []
  private spent = false
  /** Take on an undo the lab recorded while this context's module was being set up (a direct registration). */
  adopt(undo: Dispose) { this.undo.push(this.guard(undo)) }

  constructor(readonly id: string, readonly config: Record<string, unknown>, readonly stateDir: string, private readonly loader: Loader) {}

  /** `undo`, which may run once: a second call (or a removal) does nothing. */
  private guard(undo: Dispose): Dispose {
    let done = false
    const once: Dispose = () => { if (done) return; done = true; const at = this.undo.indexOf(once); if (at >= 0) this.undo.splice(at, 1); return undo() }
    return once
  }

  /**
   * Run `run` as one undoable step. What it registers on the lab is undone with it, and so is whatever it returns: a
   * plugin can hand back its undo, or just call `lab.…` and let the lab's own undo be kept for it.
   */
  effect(run: () => Dispose | void): Dispose {
    if (this.spent) throw new Error(`plugin ${this.id} is not running`)
    const collected: Dispose[] = []
    const given = this.loader.within(run, collected)
    if (typeof given === 'function') collected.push(given)
    if (!collected.length) throw new Error(`plugin ${this.id}: an effect must register something, to undo it later`)
    const once = this.guard(() => {
      let first: unknown = null
      for (const undo of collected.splice(0).reverse()) {
        try { const result = undo(); if (result instanceof Promise) first ??= result } catch (error) { first ??= error }
      }
      if (first instanceof Error) throw first
      return first as Promise<void> | void
    })
    this.undo.push(once)
    return once
  }

  /** Undo everything this plugin registered, newest first; a failing undo never stops the others. */
  async take() {
    if (this.spent) return
    this.spent = true
    for (const undo of this.undo.splice(0).reverse()) {
      try { await undo() } catch (error) { this.loader.report(this.id, error) }
    }
  }

  on(event: string, listener: (payload: unknown) => void): Dispose { return this.effect(() => this.loader.registry.event(event, listener)) }

  provide<T>(name: string, service: T): T {
    if (this.loader.services.has(name)) throw new Error(`service ${name} is provided twice (${this.id})`)
    this.undo.push(this.guard(() => { this.loader.services.delete(name) }))
    this.provided.push(name)
    this.loader.services.set(name, service)
    return service
  }

  service<T>(name: string): T {
    const found = this.loader.services.get(name)
    if (found === undefined) throw new Error(`service ${name} is not provided (needed by ${this.id})`)
    return found as T
  }

  log(line: string) { this.loader.log(this.id, line) }
}

export interface LoaderOptions {
  /** What a module's setup is given: the lab it plugs into. */
  lab: unknown
  /** boardd's state directory, given to every module's context. */
  stateDir: string
  registry: Registry
  /** Where a module's own log lines go. */
  log?: (id: string, line: string) => void
  /** Where a failed setup or undo is reported. */
  report?: (id: string, error: unknown) => void
}

export class Loader {
  readonly services = new Map<string, unknown>()
  private readonly entries = new Map<string, Entry>()
  private readonly order: string[] = []
  /** The module being set up right now, if any: what a direct `lab.…` registration is recorded with. */
  private setting: Context | null = null

  /** The effect running right now: what it registers on the lab is undone with it, not with the module's setup. */
  private collecting: Dispose[] | null = null

  /** Record an undo: with the effect running now, or else with the module being set up (see `plugin-registry.ts`). */
  record(undo: Dispose) {
    if (this.collecting) this.collecting.push(undo)
    else this.setting?.adopt(undo)
  }

  /** Run `run`, collecting what it registers on the lab into `collected`. */
  within<T>(run: () => T, collected: Dispose[]): T {
    const outer = this.collecting
    this.collecting = collected
    try { return run() } finally { this.collecting = outer }
  }

  constructor(private readonly options: LoaderOptions) {}

  get registry(): Registry { return this.options.registry }
  log(id: string, line: string) { this.options.log?.(id, line) }
  report(id: string, error: unknown) { if (this.options.report) this.options.report(id, error); else throw error }

  has(id: string): boolean { return this.entries.get(id)?.status === 'active' }

  /** A service by name: a module's API is one, under its id. */
  service<T>(name: string): T {
    const found = this.services.get(name)
    if (found === undefined) throw new Error(`service ${name} is not provided`)
    return found as T
  }

  /** A running module's API. */
  api<T>(id: string): T {
    const entry = this.entries.get(id)
    if (!entry || entry.status !== 'active') throw new Error(`module ${id} is not loaded`)
    return entry.api as T
  }

  /** The services a module needs that nobody offers now. */
  missing(id: string): string[] {
    const entry = this.entries.get(id)
    if (!entry) return []
    const modules = (entry.module.requires ?? []).filter(id => !this.has(id))
    return [...modules, ...(entry.module.inject ?? []).filter(name => !this.services.has(name))]
  }

  /**
   * Set a module up. Its `requires` and `inject` must be offered already (the caller orders them; boardd reports a
   * module whose services are missing as pending). Its registrations go through the context, so `remove` undoes them.
   */
  add(module: Module, config: Record<string, unknown> = {}): unknown {
    if (this.entries.has(module.id)) throw new Error(`module ${module.id} is loaded twice`)
    const missing = [...(module.requires ?? []).filter(id => !this.has(id)), ...(module.inject ?? []).filter(name => !this.services.has(name))]
    const ctx = new Context(module.id, config, this.options.stateDir, this)
    if (missing.length) {
      this.entries.set(module.id, { module, ctx, api: undefined, status: 'pending', why: `needs ${missing.join(', ')}` })
      this.order.push(module.id)
      return undefined
    }
    try {
      const outer = this.setting
      this.setting = ctx
      let api: unknown
      try { api = module.setup(this.options.lab, ctx) } finally { this.setting = outer }
      if (api !== undefined && !this.services.has(module.id)) ctx.provide(module.id, api)
      for (const name of module.provide ?? []) if (!this.services.has(name)) ctx.provide(name, api)
      const entry: Entry = { module, ctx, api, status: 'active', why: null }
      this.entries.set(module.id, entry)
      this.order.push(module.id)
      return api
    } catch (error) {
      this.entries.set(module.id, { module, ctx, api: undefined, status: 'failed', why: (error as Error).message })
      this.order.push(module.id)
      this.report(module.id, error)
      return undefined
    }
  }

  /** Modules that name `service` in `inject` (a provider may be taken down only after them). */
  private dependentsOf(service: string): string[] {
    return [...this.entries.values()]
      .filter(entry => entry.status === 'active' && (entry.module.inject ?? []).includes(service))
      .map(entry => entry.module.id)
  }

  /** Take a module down: the modules that inject a service it provides, then it. Undoes its registrations in reverse. */
  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    // Everything it offered declares who else has to go first: the modules that injected it.
    for (const name of [...entry.ctx.provided, ...(entry.module.provide ?? [])]) {
      for (const dependent of this.dependentsOf(name)) if (dependent !== id) await this.remove(dependent)
    }
    await entry.ctx.take()
    this.services.delete(id)
    this.entries.delete(id)
    const at = this.order.indexOf(id)
    if (at >= 0) this.order.splice(at, 1)
  }

  /** Take every module down, newest first (boardd stopping). */
  async stop(): Promise<void> {
    for (const id of [...this.order].reverse()) await this.remove(id)
  }

  /** A module that was pending may be set up now (a service it needed arrived): try it again. */
  resume(): void {
    for (const state of this.list()) {
      if (state.status !== 'pending') continue
      const entry = this.entries.get(state.id)!
      const ctx = entry.ctx
      if (this.missing(state.id).length) continue
      try {
        const outer = this.setting
        this.setting = ctx as Context
        let api: unknown
        try { api = entry.module.setup(this.options.lab, ctx) } finally { this.setting = outer }
        for (const name of [...(entry.module.provide ?? []), state.id]) if (!this.services.has(name)) ctx.provide(name, api)
        entry.api = api
        entry.status = 'active'
        entry.why = null
      } catch (error) {
        entry.status = 'failed'
        entry.why = (error as Error).message
        this.report(entry.module.id, error)
      }
    }
  }

  list(): PluginState[] {
    return this.order.flatMap(id => {
      const entry = this.entries.get(id)
      if (!entry) return []
      const module = entry.module
      return [{
        id: module.id, title: module.title, about: module.about ?? '', tags: module.tags ?? [],
        inject: module.inject ?? [], provide: module.provide ?? [], status: entry.status, why: entry.why,
      }]
    })
  }
}
