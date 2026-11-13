/**
 * The flasher-host backends boardlab fronts, by instance: this machine's own hardware, a rack behind a management controller, a fleet of board hosts.
 * Each board is on one of them. Instances with access settings are configured on the page (a "lab"); a listing backend
 * lists its boards itself, and boardlab keeps them in step: the list, their backend leases, their news and free ports.
 */
import { randomUUID } from 'node:crypto'
import type { Board, LabPorts, LabSettings, Proposal } from '../shared/types.ts'
import { DEVICE_PATTERN, deviceFilter, JUMP, type Backend, type BoardTarget, type LabConfig, type LabDevice, type LabDiscovery, type LabFinding, type LabNews, type LabSlots } from './backend.ts'
import { transaction } from './db.ts'
import { renameBoard } from './rename.ts'
import { BoardError, BusyError } from './errors.ts'
import type { BoardLab } from './lab.ts'
import type { Caller } from './locks.ts'
import { BOARD_NAME, str } from './text.ts'

export interface Instance {
  id: string
  backend: Backend
  /** Configured on the page with access settings and switched on there; the default one has none. */
  configurable: boolean
  /** The kind it was added as, at runtime (see `offer`); null for one a module registered itself. */
  kind: string | null
}

/**
 * A kind of lab a module offers, so people add labs of it at runtime (on the page or with the CLI) instead of naming
 * them in boardd's configuration. What setting one up takes (a form, an install job) is the module's own business,
 * done through its views and API; the core only keeps the list of labs and makes each one's backend.
 */
export interface LabKind {
  kind: string
  title: string
  /** One line on what a lab of this kind is. */
  about: string
  create(id: string): Backend
}

/** A lock target as its backend addresses it, with what reaching the backend takes. */
export interface Route { id: string, backend: Backend, config: LabConfig, target: BoardTarget, isBoard: boolean }

/** Free ports heard this recently are shown without asking the backend again. */
const PORTS_FRESH_MS = 10_000
const NO_CONFIG: LabConfig = { url: '', username: '', password: '', jump: '' }

/** A host name as backends report them. */
const HOST = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/

export class Backends {
  private readonly instances = new Map<string, Instance>()
  /** The instance of boards registered without a backend: this machine's. */
  defaultId = 'local'
  /** What each listed board's backend said about it at the last listing, by board name. */
  private readonly devices = new Map<string, LabDevice>()
  /** Boards whose backend lease could not be made to follow the lock. */
  private readonly leaseErrors = new Map<string, string>()
  /** The news streams followed, by instance: each entry stops one. */
  private readonly watches = new Map<string, () => void>()
  /** Free ports as last heard, and the asks under way. */
  private readonly portCache = new Map<string, { hosts: LabSlots[], at: string | null, error: string | null }>()
  private readonly portRuns = new Map<string, Promise<void>>()
  /** Discoveries by instance: the latest progress line, and whether one is still running. */
  private readonly discoveries = new Map<string, { running: boolean, line: string, at: string }>()
  /** How to stop the search running on each instance (a person cancelling it). */
  private readonly findingStops = new Map<string, AbortController>()

  constructor(private readonly lab: BoardLab) {
    lab.locks.addOccupant(target => this.devices.get(target)?.heldBy ?? null)
    lab.locks.addTarget(target => [...this.instances.values()].some(instance => instance.backend.lockTarget?.(target) ?? false))
    lab.locks.addFollower({ binding: true, follow: target => this.followLease(target) })
    lab.locks.gated = target => { try { return !!this.route(target).backend.serial.gated } catch { return false } }
    lab.boards.addView((board, record) => this.view(board, record))
    lab.proposals.addOwner({ owns: proposal => typeof proposal.change.lab === 'string', resolve: (actor, proposals, decision, given) => this.resolve(actor, proposals, decision, given) })
  }

  // ---------- instances ----------

  register(id: string, backend: Backend, options: { configurable?: boolean, isDefault?: boolean, kind?: string } = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id)) throw new Error(`backend id ${id}`)
    if (this.instances.has(id)) throw new Error(`backend ${id} is registered twice`)
    this.instances.set(id, { id, backend, configurable: options.configurable ?? true, kind: options.kind ?? null })
    if (options.isDefault) this.defaultId = id
  }

  // ---------- kinds: labs added at runtime ----------

  private readonly kinds = new Map<string, LabKind>()

  /** A module offers a kind of lab; the labs of it added before are made again. */
  offer(kind: LabKind) {
    if (this.kinds.has(kind.kind)) throw new Error(`lab kind ${kind.kind} is offered twice`)
    this.kinds.set(kind.kind, kind)
    for (const added of this.added()) if (added.kind === kind.kind && !this.instances.has(added.id)) this.register(added.id, kind.create(added.id), { kind: kind.kind })
  }

  kindsOffered(): Array<{ kind: string, title: string, about: string }> { return [...this.kinds.values()].map(({ kind, title, about }) => ({ kind, title, about })) }

  private added(): Array<{ id: string, kind: string }> {
    try { return JSON.parse(this.lab.kernel.setting('labs.added') ?? '[]') } catch { return [] }
  }

  /** Add a lab of an offered kind; it starts switched off, for its module to set up and switch on. */
  add(actor: string, id: string, kind: string): LabSettings {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id)) throw new BoardError('invalid', `实验室名只能用字母、数字、横线和下划线，最长 32：${id}`)
    const offered = this.kinds.get(kind)
    if (!offered) throw new BoardError('invalid', `没有这种实验室：${kind}（有：${[...this.kinds.keys()].join('、') || '（无）'}）`)
    if (this.instances.has(id)) throw new BoardError('conflict', `已经有实验室 ${id}`)
    this.register(id, offered.create(id), { kind })
    this.lab.kernel.setSetting('labs.added', JSON.stringify([...this.added(), { id, kind }]))
    this.lab.kernel.record(actor, null, 'lab-add', `${id}（${offered.title}）`, true, null)
    this.lab.kernel.changed(null)
    return this.labSetting(id)
  }

  /** Remove a lab added at runtime: its boards go, so none may be held. */
  async removeLab(actor: string, id: string): Promise<void> {
    const instance = this.get(id)
    if (!instance.kind) throw new BoardError('invalid', `实验室 ${id} 是在 boardd 的配置里写的，不能在这里删`)
    const held = this.heldIn(id)
    if (held) throw new BoardError('locked', `${String(held.board)} 正被 ${String(held.holder)} 使用，放锁以后才能删实验室`)
    this.watches.get(id)?.()
    this.watches.delete(id)
    transaction(this.lab.kernel.db, () => {
      this.dropBoards(id, () => true)
      for (const key of ['enabled', 'url', 'username', 'password', 'jump', 'devices', 'synced_at', 'sync_ok', 'sync_message', 'verified_at', 'verify_ok', 'verify_message']) this.settings(id).set(key, null)
      this.lab.kernel.setSetting('labs.added', JSON.stringify(this.added().filter(item => item.id !== id)))
    })
    this.instances.delete(id)
    this.lab.kernel.record(actor, null, 'lab-remove', id, true, null)
    this.lab.kernel.changed(null)
  }

  list(): Instance[] { return [...this.instances.values()] }

  get(id: string): Instance {
    const instance = this.instances.get(id)
    if (!instance) throw new BoardError('not-found', `没有实验室 ${id}`)
    return instance
  }

  private configurable(id: string): Instance {
    const instance = this.get(id)
    if (!instance.configurable) throw new BoardError('not-found', `没有实验室 ${id}`)
    return instance
  }

  private settings(id: string) { return this.lab.kernel.settings(`lab.${id}`) }

  private fields(id: string) { return this.get(id).backend.fields ?? {} }

  /** The required settings the instance is missing, by label. */
  private missing(id: string, values: Record<string, string | null>): string[] {
    return Object.entries(this.fields(id)).filter(([key, field]) => field?.required && !values[key]).map(([, field]) => field!.label)
  }

  /** What reaching an instance takes, as configured; it must be switched on. */
  config(id: string): LabConfig {
    const instance = this.get(id)
    if (!instance.configurable) return NO_CONFIG
    const get = this.settings(id).get
    if (get('enabled') !== '1') throw new BoardError('invalid', `实验室 ${id} 没有开启`)
    const url = get('url'), username = get('username'), password = get('password')
    const missing = this.missing(id, { url, username, password })
    if (missing.length) throw new BoardError('invalid', `实验室 ${id} 的${missing.join('、')}没有填`)
    const jump = get('jump') ?? (url && this.fields(id).jump ? instance.backend.defaultJump?.(new URL(url)) ?? '' : '')
    return { url: url ?? '', username: username ?? '', password: password ?? '', jump }
  }

  /** The backend a lock target is on, and how it addresses the target (one of its chips, for a board). */
  route(target: string, die?: string): Route {
    const db = this.lab.kernel.db
    const row = db.prepare('SELECT lab, lab_device, lab_token FROM boards WHERE name=?').get(target)
    if (row) {
      const id = str(row.lab) ?? this.defaultId
      const instance = this.instances.get(id)
      if (!instance) throw new BoardError('invalid', `${target} 所在的后端 ${id} 没有装上`)
      const chip = die
        ? db.prepare('SELECT die, alias, download_usb_path FROM chips WHERE board=? AND die=?').get(target, die)
        : db.prepare('SELECT die, alias, download_usb_path FROM chips WHERE board=? ORDER BY die LIMIT 1').get(target)
      return {
        id, backend: instance.backend, config: this.config(id), isBoard: true,
        target: { board: target, device: str(row.lab_device) ?? target, lease: str(row.lab_token), die: str(chip?.die) ?? die ?? 'die0', usbPath: str(chip?.download_usb_path), port: str(chip?.alias), gate: this.lab.locks.held(target)?.gateToken ?? null },
      }
    }
    const instance = [...this.instances.values()].find(item => item.backend.lockTarget?.(target))
    if (!instance) throw new BoardError('not-found', `没有这块板：${target}`)
    return {
      id: instance.id, backend: instance.backend, config: this.config(instance.id), isBoard: false,
      target: { board: target, device: target, lease: null, die: die ?? 'die0', usbPath: null, port: null, gate: this.lab.locks.held(target)?.gateToken ?? null },
    }
  }

  /** What a board's backend knows about it now: whether its console is up and, for a listed board, the backend's view. */
  private view(board: Board, record: { backend: string, device: string | null }) {
    const instance = this.instances.get(record.backend)
    if (!instance) return
    const device = this.devices.get(board.name)
    if (instance.backend.inventory) {
      // A listed board's console is the backend's serial reader, usable while it has the port open.
      for (const chip of board.chips) chip.online = !!device?.serialConnected
      board.lab = {
        id: instance.id, device: record.device ?? board.name, online: !!device?.online, ip: device?.ip ?? null,
        heldBy: device?.heldBy ?? null, leaseError: this.leaseErrors.get(board.name) ?? null,
        empty: !!device?.empty, slotGone: !!device?.slotGone, canRefresh: !!instance.backend.inventory.refresh && !device?.empty,
        mediaBoot: device?.mediaBoot ? { method: device.mediaBoot.method, available: device.mediaBoot.available, why: device.mediaBoot.why ?? null } : null,
        attention: this.lab.relay.attention(board.name) ?? device?.attention ?? null, canConfirm: !!instance.backend.relay.confirm,
        sdks: device?.sdks ?? [], progress: this.lab.download.progress(board.name),
        canFlashPackage: !!instance.backend.builds?.flash && !device?.empty,
      }
    } else if (instance.backend.serial.online) {
      for (const chip of board.chips) {
        chip.online = instance.backend.serial.online({ board: board.name, device: board.name, lease: null, die: chip.die, usbPath: chip.downloadUsbPath, port: chip.alias, gate: null })
      }
    }
  }

  /** What the SDK builds a board's backend can boot it with, as last listed (empty: any, or unknown). */
  builds(board: string): string[] { return this.devices.get(board)?.sdks ?? [] }

  /**
   * Before a board leaves the list: a backend with a registry of its own forgets it there; boards of other listing
   * backends follow the listing and cannot be removed by hand. Returns what to log about it.
   */
  async release(actor: string, board: Board): Promise<string | null> {
    if (!board.lab) return null
    const instance = this.get(board.lab.id)
    const remove = instance.backend.inventory?.remove
    if (!remove) throw new BoardError('invalid', `${board.name} 跟着实验室 ${instance.id} 的设置走：改设备范围或关掉实验室`)
    if (board.lab.heldBy) throw new BoardError('locked', `${board.name} 在实验室里正被 ${board.lab.heldBy} 使用`)
    try { await remove(this.config(instance.id), board.lab.device) }
    catch (error) {
      this.lab.kernel.record(actor, board.name, 'remove', instance.id, false, (error as Error).message)
      throw new BoardError('hardware', (error as Error).message)
    }
    this.devices.delete(board.name)
    return instance.id
  }

  // ---------- leases ----------

  /**
   * Make a board's backend lease follow its lock: held for the lock's holder (renewed, and renamed on handover or
   * steal) while the board is locked, given back when it is free. Failures are kept and shown.
   */
  private async followLease(board: string): Promise<string | null> {
    let route: Route
    try { route = this.route(board) } catch { return null }
    const lease = route.backend.lease
    if (!lease || !route.isBoard) return null
    const token = route.target.lease
    const held = this.lab.locks.held(board)
    const before = this.leaseErrors.get(board) ?? null
    let error: string | null = null
    if (held) {
      const who = { holder: `boardlab:${held.holder}`, purpose: held.purpose }
      try {
        let next: string
        // A lease that ran out while boardd was away is taken again rather than renewed.
        try { next = await lease.take(route.config, route.target.device, { ...who, token }) }
        catch (failure) { if (!token) throw failure; next = await lease.take(route.config, route.target.device, { ...who, token: null }) }
        if (next !== token) this.lab.kernel.db.prepare('UPDATE boards SET lab_token=? WHERE name=?').run(next, board)
      } catch (failure) { error = (failure as Error).message }
    } else if (token) {
      try { await lease.give(route.config, route.target.device, token) } catch {}
      this.lab.kernel.db.prepare('UPDATE boards SET lab_token=NULL WHERE name=?').run(board)
    }
    if (error) this.leaseErrors.set(board, error); else this.leaseErrors.delete(board)
    if (error !== before) {
      if (error) this.lab.kernel.record('boardd', board, 'lab-lease', route.id, false, error)
      this.lab.kernel.changed(board)
    }
    return error
  }

  // ---------- settings ----------

  labSettings(): LabSettings[] {
    return this.list().filter(instance => instance.configurable).map(({ id, backend, kind: addedAs }) => {
      const { get, flag } = this.settings(id)
      const url = get('url')
      const fields = backend.fields ?? {}
      return {
        id, kind: backend.kind, addedAs, about: backend.about ?? '', fields, canDiscover: !!backend.discovery, canRebuild: !!backend.discovery?.rebuild, canRediscover: !!backend.discovery?.rebuild && !!backend.discovery.keepsInUse, canRemove: !!backend.inventory?.remove, canBind: !!backend.ports, canRelay: !!backend.channels,
        hosts: [...new Set([...this.devices].filter(([name]) => name.startsWith(`${id}-`)).map(([, device]) => device.host).filter((host): host is string => !!host))].sort(),
        discovery: this.discoveries.get(id) ?? null, busy: this.lab.kernel.busy.get(`lab:${id}`) ?? null, enabled: get('enabled') === '1', url, username: get('username'), hasPassword: !!get('password'),
        jump: get('jump'), defaultJump: url && fields.jump ? backend.defaultJump?.(new URL(url)) ?? null : null, devices: get('devices'),
        verifiedAt: get('verified_at'), verifyOk: flag('verify_ok'), verifyMessage: get('verify_message'),
        syncedAt: get('synced_at'), syncOk: flag('sync_ok'), syncMessage: get('sync_message'),
      }
    })
  }

  private labSetting(id: string): LabSettings { return this.labSettings().find(lab => lab.id === id)! }

  /** A held lease on any of the instance's boards here, except those `ignore` names. */
  private heldIn(id: string, ignore: (board: string) => boolean = () => false) {
    return this.lab.kernel.db.prepare(`SELECT leases.board, leases.holder FROM leases JOIN boards ON boards.name = leases.board WHERE boards.lab=? AND leases.status='held'`).all(id)
      .find(row => !ignore(String(row.board)))
  }

  /**
   * Read the board in a slot again after someone swapped it, under its lock. The backend identifies it and updates its
   * record; a new name comes back at the next listing as the same slot's board, which keeps its lock. Returns the
   * board's name afterwards.
   */
  async refresh(board: string, caller: Caller, options: { name?: string | null, rename?: boolean } = {}, signal?: AbortSignal): Promise<{ board: string, message: string }> {
    const lease = this.lab.locks.authorize(board, caller)
    const route = this.route(board)
    const refresh = route.backend.inventory?.refresh
    if (!refresh || !route.isBoard) throw new BoardError('invalid', `${board} 所在的后端 ${route.id} 不能重新读取板子`)
    if (this.devices.get(board)?.empty) throw new BoardError('invalid', `${board} 是空槽位，还没有登记板子：先发现它（boardlab lab discover ${route.id} --slot ${this.devices.get(board)?.slot ?? '<槽位>'}）`)
    if (options.name && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(options.name)) throw new BoardError('invalid', `板名不合法：${options.name}`)
    const detail = options.name ? `改名为 ${options.name}` : options.rename ? '按读到的型号改名' : null
    let out: { device: string, message: string }
    const { notice, done } = this.lab.relay.asking(board, signal)
    try {
      out = await refresh(route.config, route.target, options, line => {
        const asked = line.match(/ACTION NEEDED: (.*)$/)
        if (asked) notice(asked[1]!)
      }, signal)
    } catch (error) {
      this.lab.kernel.record(lease.holder, board, 'refresh', detail, false, (error as Error).message)
      throw new BoardError('hardware', (error as Error).message)
    } finally { done() }
    await this.sync(route.id).catch(() => {})
    const now = str(this.lab.kernel.db.prepare('SELECT name FROM boards WHERE lab=? AND lab_device=?').get(route.id, out.device)?.name) ?? board
    this.lab.kernel.record(lease.holder, now, 'refresh', detail, true, out.message)
    this.lab.boards.setMode(now, 'unknown')
    this.lab.kernel.changed(now)
    return { board: now, message: out.message }
  }

  /**
   * Rename a board everywhere: the backend's own record (a lab's DUT and console alias, this machine's serial-mux
   * daemons), boardd's board and chips, its lock, queue, actions and proposals. While someone holds it, only they may
   * rename it and the lock goes with it; a busy board cannot be renamed. A lab board's name keeps the lab's prefix
   * (giving `foo` renames `bsp-foo`). Returns the name afterwards. See rename.ts.
   */
  rename(actor: string, board: string, to: string, caller: Caller): Promise<{ board: string, message: string }> {
    return renameBoard({
      lab: this.lab, devices: this.devices, leaseErrors: this.leaseErrors,
      route: (target, die) => this.route(target, die), sync: id => this.sync(id),
    }, actor, board, to, caller)
  }

  /**
   * Save an instance's access and whether boardd uses it. The password is write-only: omit it to keep the stored one.
   * Enabling checks the access and lists the boards; disabling takes them off the list, once nobody holds any of them.
   */
  async configure(actor: string, id: string, input: { enabled: boolean, url?: string | null, username?: string | null, password?: string | null, jump?: string | null, devices?: string | null }): Promise<LabSettings> {
    this.configurable(id)
    const settings = this.settings(id)
    let url: string | null = null
    if (input.url?.trim()) {
      let parsed: URL
      try { parsed = new URL(input.url.trim()) } catch { throw new BoardError('invalid', '实验室地址不合法') }
      // http(s), ssh, or a backend's own scheme on them (`bspd+http:`); never file: or javascript:.
      if (!/^([a-z][a-z0-9.-]*\+)?(https?|ssh):$/.test(parsed.protocol)) throw new BoardError('invalid', '实验室地址须是 http、https 或 ssh')
      url = parsed.toString().replace(/\/$/, '')
    }
    const jump = input.jump?.trim() || null
    if (jump && !JUMP.test(jump)) throw new BoardError('invalid', `跳板机格式不对：${jump}（要写成 user@host 或 user@host:port）`)
    const devices = (input.devices ?? '').split(/[\s,]+/).filter(Boolean)
    const bad = devices.find(item => !DEVICE_PATTERN.test(item))
    if (bad) throw new BoardError('invalid', `设备范围里有不合法的名字：${bad}（只能用字母、数字、点、横线、下划线和 *）`)
    const username = input.username?.trim() || null
    const password = input.password || settings.get('password')
    const missing = this.missing(id, { url, username, password })
    if (input.enabled && missing.length) throw new BoardError('invalid', `开启实验室要先填${missing.join('、')}`)
    if (!input.enabled) {
      const held = this.heldIn(id)
      if (held) throw new BoardError('locked', `${String(held.board)} 正被 ${String(held.holder)} 使用，放锁以后才能关掉实验室`)
    }
    transaction(this.lab.kernel.db, () => {
      settings.set('enabled', input.enabled ? '1' : '0')
      settings.set('url', url)
      settings.set('username', username)
      if (input.password) settings.set('password', input.password)
      settings.set('jump', jump)
      settings.set('devices', devices.length ? devices.join(' ') : null)
      if (!input.enabled) this.dropBoards(id, () => true)
    })
    this.lab.kernel.record(actor, null, 'lab-config', `${id}${input.enabled ? ' 开启' : ' 关闭'}`, true, input.password ? '已更新密码' : null)
    this.lab.kernel.changed(null)
    this.follow()
    if (input.enabled) return this.test(actor, id)
    return this.labSetting(id)
  }

  /** Check an instance's access, then list its boards again. */
  async test(actor: string, id: string): Promise<LabSettings> {
    const { backend } = this.configurable(id)
    const config = this.config(id)
    const settings = this.settings(id)
    let ok = true, message: string
    try { message = backend.inventory ? await backend.inventory.verify(config) : '没有可检查的' }
    catch (error) { ok = false; message = (error as Error).message }
    settings.set('verified_at', this.lab.kernel.iso())
    settings.set('verify_ok', ok ? '1' : '0')
    settings.set('verify_message', message)
    this.lab.kernel.record(actor, null, 'lab-test', id, ok, message)
    // A lab whose jump host is out of reach still has power and consoles.
    await this.sync(id, actor).catch(() => {})
    this.lab.kernel.changed(null)
    return this.labSetting(id)
  }

  // ---------- discovery ----------

  /**
   * Have an instance look for new boards, as proposals for a person to apply. A backend looks only on what no board
   * uses yet (free reset lines, consoles and download ports, or empty slots), so boards in use are never touched and
   * held boards do not stop it. It may reset whatever is plugged into the free lines, so it needs confirmation.
   */
  async discover(actor: string, id: string, confirmed: boolean, options: LabDiscovery = {}): Promise<{ message: string, proposals: number, registered: string[] }> {
    const { backend } = this.configurable(id)
    if (!backend.discovery) throw new BoardError('invalid', `实验室 ${id} 不能自己发现板子`)
    if (!confirmed) throw new BoardError('forbidden', '发现板子可能复位实验室里的板子，需要用户确认')
    if (options.host && !HOST.test(options.host)) throw new BoardError('invalid', `主机名不合法：${options.host}`)
    const badSlot = (options.slots ?? []).find(slot => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}\/s\d+$/.test(slot))
    if (badSlot) throw new BoardError('invalid', `槽位要写成 <主机>/s<N>：${badSlot}`)
    const discovery = backend.discovery
    // The slots it looks in show as being discovered: those asked for, else the empty ones (on the host asked for).
    const on = this.onLab(id)
    const targets = options.slots?.length ? on.filter(([, device]) => options.slots!.includes(device.slot ?? '')).map(([name]) => name)
      : on.filter(([, device]) => device.empty && (!options.host || device.slot?.startsWith(`${options.host}/`))).map(([name]) => name)
    return this.finding(actor, id, 'lab-discover', targets, '发现中',
      options.human ? `开始人工发现${options.host ? `（${options.host}）` : ''}：按提示逐块让未登记的板子进下载模式` : '开始发现板子',
      `${id}${options.human ? ` 人工${options.host ? ` ${options.host}` : ''}` : ''}${options.slots?.length ? ` ${options.slots.join(',')}` : ''}`,
      (progress, registered, signal) => discovery.discover(this.config(id), { human: !!options.human, host: options.host ?? null, slots: options.slots ?? [], ...(options.prefer?.length ? { prefer: options.prefer } : {}) }, progress, registered, signal))
  }

  /**
   * Have an instance start one host over after it was re-cabled (`DiscoveryCapability.rebuild`). It forgets that host's
   * boards, so nobody may hold any of them, empty slots included; boards on other hosts may stay held.
   *
   * `keepInUse` rediscovers instead: the backend keeps the boards in use untouched and redoes only what moved, so it
   * runs while boards on the host are held.
   */
  async rebuild(actor: string, id: string, confirmed: boolean, host: string, keepInUse = false): Promise<{ message: string, proposals: number, registered: string[] }> {
    const { backend } = this.configurable(id)
    const rebuild = backend.discovery?.rebuild?.bind(backend.discovery)
    if (!rebuild) throw new BoardError('invalid', `实验室 ${id} 不能重建主机`)
    if (keepInUse && !backend.discovery?.keepsInUse) throw new BoardError('invalid', `实验室 ${id} 不能保留在用的板子重新发现，只能整台重建`)
    if (!confirmed) throw new BoardError('forbidden', keepInUse ? '重新发现会复位这台主机上没人用的板子，需要用户确认' : '重建会忘掉这台主机上的板子并复位它们，需要用户确认')
    if (!host || !HOST.test(host)) throw new BoardError('invalid', `主机名不合法：${host || '（空）'}`)
    if (!keepInUse) this.assertNoneHeld(id, name => { const slot = this.devices.get(name)?.slot; return !!slot && !slot.startsWith(`${host}/`) })
    const [start, detail] = keepInUse ? [`开始重新发现 ${host}：保留在用的板子，只重做变动的`, `${id} 重新发现 ${host}`] : [`开始重建 ${host}：按现在的接线重新发现它的板子`, `${id} 重建 ${host}`]
    const targets = this.onLab(id).filter(([name, device]) => device.slot?.startsWith(`${host}/`) && !(keepInUse && (this.lab.locks.held(name) || device.heldBy))).map(([name]) => name)
    const result = await this.finding(actor, id, 'lab-rebuild', targets, keepInUse ? '重新发现中' : '重建中', start, detail,
      (progress, registered, signal) => rebuild(this.config(id), host, progress, registered, { keepInUse }, signal))
    await this.sync(id, actor).catch(() => {})
    return result
  }

  /** The boards of instance `id` here, with what its backend last said of each. */
  private onLab(id: string) { return [...this.devices].filter(([name]) => name.startsWith(`${id}-`)) }

  /** Nobody holds a board of instance `id` that `ignore` does not exempt, here or in the backend. */
  private assertNoneHeld(id: string, ignore: (board: string) => boolean) {
    const held = this.heldIn(id, ignore)
    if (held) throw new BoardError('locked', `${String(held.board)} 正被 ${String(held.holder)} 使用，这会复位板子，未开始`)
    const outside = [...this.devices].find(([name, device]) => name.startsWith(`${id}-`) && device.heldBy && !ignore(name))
    if (outside) throw new BoardError('locked', `${outside[0]} 在实验室里正被 ${outside[1].heldBy} 使用，这会复位板子，未开始`)
  }

  /**
   * Run a backend's search for boards (a discovery or a rebuild): one at a time per instance, its progress on the page,
   * each board it registers listed at once, and what it could not register left as proposals for a person. The boards
   * and slots it may touch (`targets`) show it as their state while it runs, and nothing else starts on them.
   */
  private async finding(actor: string, id: string, kind: string, targets: string[], label: string, start: string, detail: string,
    search: (progress: (line: string) => void, registered: (device: string) => void, signal: AbortSignal) => Promise<{ message: string, found: LabFinding[] }>) {
    if (this.discoveries.get(id)?.running) throw new BoardError('conflict', `实验室 ${id} 已经在发现板子`)
    const stop = new AbortController()
    this.findingStops.set(id, stop)
    const report = (line: string, running = true) => { this.discoveries.set(id, { running, line, at: this.lab.kernel.iso() }); this.lab.kernel.changed(null) }
    report(start)
    let result: { message: string, found: LabFinding[] }
    const registered: string[] = []
    // Each board the backend registers as it goes is listed at once, while the search goes on.
    const onRegistered = (device: string) => { registered.push(device); void this.sync(id, actor).catch(() => {}) }
    // A person's cancel and the lock's end both stop it: whichever comes first.
    const run = (line: (text: string) => void, signal: AbortSignal) => search(
      text => { report(text); line(text) }, onRegistered, AbortSignal.any([signal, stop.signal]))
    try { result = targets.length ? await this.lab.kernel.doing(targets, kind === 'lab-discover' ? 'discover' : 'rebuild', label, actor, run) : await run(() => {}, stop.signal) }
    catch (error) {
      if (error instanceof BusyError) { report(`没开始：${error.message}`, false); this.findingStops.delete(id); throw error }
      if (stop.signal.aborted) {
        report('已取消', false)
        this.lab.kernel.record(actor, null, kind, detail, false, '已取消')
        this.findingStops.delete(id)
        throw new BoardError('conflict', `实验室 ${id} 的发现已取消（已经登记和正在跑的那一步可能还会完成）`)
      }
      report(`失败：${(error as Error).message}`, false)
      this.lab.kernel.record(actor, null, kind, detail, false, (error as Error).message)
      this.findingStops.delete(id)
      throw new BoardError('hardware', (error as Error).message)
    } finally {
      this.findingStops.delete(id)
    }
    // A new search replaces the instance's earlier proposals.
    const scanId = `lab:${id}:${randomUUID()}`
    transaction(this.lab.kernel.db, () => {
      this.lab.proposals.supersede(proposal => proposal.scanId.startsWith(`lab:${id}:`))
      for (const finding of result.found) {
        const summary = finding.summary + (finding.warnings.length ? `（注意：${finding.warnings.join('；')}）` : '')
        this.lab.proposals.add(scanId, 'new-board', null, null, summary, { lab: id, name: finding.name, finding })
      }
    })
    if (registered.length) await this.sync(id, actor).catch(() => {})
    report(result.message, false)
    this.lab.kernel.record(actor, null, kind, detail, true, result.message)
    this.lab.kernel.changed(null)
    return { message: result.message, proposals: result.found.length, registered }
  }

  /**
   * Have a discovery or rebuild stop: the backend's current step is told to end (a probe's client is stopped; the
   * host's job may still finish the step it runs). Boards it touched stop showing busy.
   */
  async cancelDiscovery(actor: string, id: string): Promise<{ message: string }> {
    this.configurable(id)
    const stop = this.findingStops.get(id)
    if (!stop || !this.discoveries.get(id)?.running) throw new BoardError('conflict', `实验室 ${id} 没有在找板子`)
    stop.abort(new Error('取消'))
    this.lab.kernel.record(actor, null, 'lab-discover-cancel', id, true, null)
    this.lab.kernel.changed(null)
    return { message: `让 ${id} 的发现停下：已经登记和正在进行的那一步会留着，不会影响别的板子` }
  }

  /** Proposals from a discovery: applying registers each board in its backend, under the name given or suggested. */
  private async resolve(actor: string, proposals: Proposal[], decision: 'apply' | 'reject', given: Record<string, string>) {
    const failures: string[] = []
    const touched = new Set<string>()
    for (const proposal of proposals) {
      const id = String(proposal.change.lab)
      const name = (given[proposal.id] ?? String(proposal.change.name)).trim()
      if (decision === 'apply') {
        const { backend } = this.configurable(id)
        if (!backend.discovery) throw new BoardError('invalid', `实验室 ${id} 不能登记板子`)
        if (!DEVICE_PATTERN.test(name) || name.includes('*')) throw new BoardError('invalid', `板名不合法：${name}（只能用字母、数字、点、横线和下划线）`)
        try { await backend.discovery.register(this.config(id), proposal.change.finding as LabFinding, name) }
        catch (error) {
          failures.push(`${name}：${(error as Error).message}`)
          this.lab.kernel.record(actor, `${id}-${name}`, 'proposal-apply', proposal.summary, false, (error as Error).message)
          continue
        }
        touched.add(id)
      }
      this.lab.proposals.mark(proposal.id, decision === 'apply' ? 'applied' : 'rejected')
      this.lab.kernel.record(actor, decision === 'apply' ? `${id}-${name}` : null, `proposal-${decision}`, proposal.summary, true)
    }
    for (const id of touched) await this.sync(id, actor).catch(() => {})
    this.lab.kernel.changed(null)
    if (failures.length) throw new BoardError('hardware', `有板子没能登记：${failures.join('；')}`)
  }

  // ---------- free ports ----------

  /**
   * An instance's free ports by host: serial consoles and download ports no board uses yet. What it said last is returned
   * at once and asked again in the background when older than a few seconds (or always, with `fresh`, which then waits
   * for the answer). Each answer is announced.
   */
  async ports(id: string, options: { fresh?: boolean } = {}): Promise<LabPorts> {
    if (!this.configurable(id).backend.ports) throw new BoardError('invalid', `实验室 ${id} 不列空闲端口`)
    const known = this.portCache.get(id)
    const stale = !known?.at || this.lab.kernel.now() - Date.parse(known.at) > PORTS_FRESH_MS
    if (options.fresh) await this.refreshPorts(id)
    else if (stale) void this.refreshPorts(id)
    const now = this.portCache.get(id)
    return { hosts: now?.hosts ?? [], at: now?.at ?? null, refreshing: this.portRuns.has(id), error: now?.error ?? null }
  }

  /** Ask an instance for its free ports again; asks already under way are joined. */
  refreshPorts(id: string): Promise<void> {
    const running = this.portRuns.get(id)
    if (running) return running
    const run = (async () => {
      const previous = this.portCache.get(id)
      try {
        const hosts = await this.configurable(id).backend.ports!.list(this.config(id))
        this.portCache.set(id, { hosts, at: this.lab.kernel.iso(), error: null })
      } catch (error) {
        this.portCache.set(id, { hosts: previous?.hosts ?? [], at: previous?.at ?? null, error: (error as Error).message })
      } finally {
        this.portRuns.delete(id)
        this.lab.kernel.emit({ type: 'lab-ports', lab: id })
      }
    })()
    this.portRuns.set(id, run)
    this.lab.kernel.emit({ type: 'lab-ports', lab: id })
    return run
  }

  /**
   * Make a board of a free console and download port, reset by a person: a slot for temporary debugging, named as given
   * or after its host and console. It is listed as `<instance>-<name>` at once.
   */
  async bind(actor: string, id: string, input: { host: string, console: string, usb: string, name?: string | null }): Promise<string> {
    const { backend } = this.configurable(id)
    if (!backend.ports) throw new BoardError('invalid', `实验室 ${id} 不能用空闲端口登记板子`)
    const safe = (text: string) => text.replace(/^\/dev\//, '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
    const name = input.name?.trim() || `tmp-${safe(input.host)}-${safe(input.console)}`
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name)) throw new BoardError('invalid', `板名不合法：${name}`)
    for (const [key, value] of Object.entries({ host: input.host, console: input.console, usb: input.usb })) {
      if (!value || !/^[A-Za-z0-9_.:/@-]{1,200}$/.test(value)) throw new BoardError('invalid', `${key} 不合法：${value}`)
    }
    // What the page showed may be old: the ports must still be free when the board is made of them.
    await this.refreshPorts(id)
    const now = this.portCache.get(id)
    if (now?.error) throw new BoardError('hardware', `问不到实验室现在的空闲端口：${now.error}`)
    const host = now?.hosts.find(item => item.host === input.host)
    const gone = [!host?.consoles.some(item => item.id === input.console) && `串口 ${input.console}`, !host?.usb.some(item => item.id === input.usb) && `下载口 ${input.usb}`].filter(Boolean)
    if (gone.length) throw new BoardError('conflict', `${input.host} 上的${gone.join('、')}已经不空闲了（被占用或拔掉了），刷新后重新选`)
    try { await backend.ports.bind(this.config(id), input.host, { console: input.console, usb: input.usb }, name) }
    catch (error) {
      this.lab.kernel.record(actor, `${id}-${name}`, 'lab-bind', `${input.host} ${input.console} ${input.usb}`, false, (error as Error).message)
      throw new BoardError('hardware', (error as Error).message)
    }
    this.lab.kernel.record(actor, `${id}-${name}`, 'lab-bind', `${input.host} ${input.console} ${input.usb}`, true)
    await this.sync(id, actor).catch(() => {})
    void this.refreshPorts(id)
    return `${id}-${name}`
  }

  // ---------- listing and news ----------

  /** List every enabled instance's boards again; one that cannot be read keeps what it had. */
  async syncAll(): Promise<void> {
    this.follow()
    for (const lab of this.labSettings().filter(item => item.enabled)) await this.sync(lab.id).catch(() => {})
  }

  /**
   * Follow the news of every enabled instance that has any, and stop following disabled ones. Runs at every sync, so a
   * stream that ended is picked up again within a minute.
   */
  follow() {
    for (const lab of this.labSettings()) {
      const { backend } = this.get(lab.id)
      const running = this.watches.get(lab.id)
      if (!lab.enabled || !backend.news) { if (running) { running(); this.watches.delete(lab.id) } continue }
      if (running) continue
      let config: LabConfig
      try { config = this.config(lab.id) } catch { continue }
      const stop = backend.news.watch(config, news => this.news(lab.id, news), () => { if (this.watches.get(lab.id) === stop) this.watches.delete(lab.id) })
      this.watches.set(lab.id, stop)
    }
  }

  /** Stop following every instance (boardd is stopping). */
  stopFollowing() { for (const stop of this.watches.values()) stop(); this.watches.clear() }

  /** News: a host's cables changed, so its free ports and boards are asked for again and the page is told. */
  private news(id: string, news: LabNews) {
    // A host announced a change (a board registered or removed, a slot came online): list the boards again.
    if (news.kind === 'hosts') return void this.sync(id).catch(() => {})
    if (this.get(id).backend.ports) void this.refreshPorts(id)
    void this.sync(id).catch(() => {})
    if (news.added.length || news.removed.length) {
      this.lab.kernel.record('boardd', null, 'lab-ports', `${id} ${news.host}`, true, [news.added.length ? `新接上 ${news.added.join(', ')}` : '', news.removed.length ? `拔掉 ${news.removed.join(', ')}` : ''].filter(Boolean).join('；'))
    }
    this.lab.kernel.emit({ type: 'lab-ports', lab: id, host: news.host, added: news.added, removed: news.removed })
  }

  /**
   * List an instance's boards: each one in its device range becomes the board `<instance>-<device>` here, with the
   * backend's serial port and download port as its chip. Boards that left the range or the backend go, unless held.
   */
  async sync(id: string, actor = 'boardd'): Promise<void> {
    const { backend } = this.configurable(id)
    if (!backend.inventory) return
    const config = this.config(id)
    const settings = this.settings(id)
    const range = settings.get('devices')
    const status = (ok: boolean, message: string) => {
      settings.set('synced_at', this.lab.kernel.iso())
      settings.set('sync_ok', ok ? '1' : '0')
      settings.set('sync_message', message)
    }
    let all: LabDevice[]
    try { all = await backend.inventory.devices(config) }
    catch (error) {
      status(false, (error as Error).message)
      this.lab.kernel.changed(null)
      throw new BoardError('hardware', (error as Error).message)
    }
    const db = this.lab.kernel.db
    const devices = all.filter(device => deviceFilter(range)(device.name))
    const listing = () => JSON.stringify(db.prepare('SELECT boards.name, chips.serial_path, chips.download_usb_path FROM boards LEFT JOIN chips ON chips.board = boards.name WHERE boards.lab=? ORDER BY boards.name').all(id))
    const known = () => JSON.stringify([...this.devices].filter(([name]) => name.startsWith(`${id}-`)))
    const before = listing(), beforeStatus = known()
    const seen = this.lab.kernel.iso()
    const listed = new Set<string>(), clashes: string[] = [], moved: string[] = []
    let kept: string[] = []
    transaction(db, () => {
      for (const device of devices) {
        const name = `${id}-${device.name}`
        const address = device.address ?? device.name
        // A board in a slot boardlab knows under another name (registered into an empty slot, swapped and read again,
        // renamed) is that slot's record: renamed in place, so its lock, queue and history stay with the slot.
        if (device.slot && BOARD_NAME.test(name) && !this.lab.boards.exists(name)) {
          const prior = db.prepare('SELECT name FROM boards WHERE lab=? AND lab_slot=?').get(id, device.slot)
          if (prior) {
            this.lab.boards.rename(String(prior.name), name)
            db.prepare('UPDATE boards SET lab_device=? WHERE name=?').run(address, name)
            this.devices.delete(String(prior.name))
            moved.push(`${String(prior.name)} → ${name}`)
          }
        }
        const existing = db.prepare('SELECT lab, lab_device FROM boards WHERE name=?').get(name)
        if (!BOARD_NAME.test(name) || (existing && (existing.lab !== id || existing.lab_device !== address))) { clashes.push(device.name); continue }
        listed.add(name)
        const soc = device.soc?.toLowerCase() ?? (device.model && /^k\d+$/i.test(device.model) ? device.model.toLowerCase() : null)
        db.prepare(`INSERT INTO boards(name, product, soc, source, lab, lab_device, lab_slot, last_seen_at) VALUES(?,?,?,'lab',?,?,?,?)
          ON CONFLICT(name) DO UPDATE SET
            product=CASE WHEN boards.product_manual THEN boards.product ELSE COALESCE(excluded.product, boards.product) END,
            soc=CASE WHEN boards.product_manual THEN boards.soc ELSE COALESCE(excluded.soc, boards.soc) END,
            lab_slot=excluded.lab_slot, last_seen_at=excluded.last_seen_at`)
          .run(name, device.model, soc, id, address, device.slot ?? null, seen)
        // A download port learned when the board last entered download mode stays until the backend names another.
        this.lab.boards.upsertChip(name, 'die0', { serial_path: device.serialPort, last_seen_at: seen, ...(device.downloadUsbPath ? { download_usb_path: device.downloadUsbPath } : {}) })
      }
      kept = this.dropBoards(id, name => !listed.has(name))
    })
    for (const name of [...this.devices.keys()]) if (name.startsWith(`${id}-`) && !listed.has(name)) this.devices.delete(name)
    for (const device of devices) {
      const name = `${id}-${device.name}`
      if (!listed.has(name)) continue
      const before = this.devices.get(name)?.attention ?? null
      this.devices.set(name, device)
      // A reset started outside boardd that waits for a person shows up in the listing; tell the page too.
      if ((device.attention ?? null) !== before && !this.lab.relay.attention(name)) this.lab.kernel.emit({ type: 'attention', board: name, message: device.attention ?? null, holder: this.lab.locks.held(name)?.holder ?? null })
    }
    const message = [
      `列出 ${listed.size} 块（实验室共 ${all.length} 台${range ? `，范围 ${range}` : ''}）`,
      ...(moved.length ? [`槽位里换了板子：${moved.join(', ')}`] : []),
      ...(clashes.length ? [`和已有的板子重名，没有列出：${clashes.join(', ')}`] : []),
      ...(kept.length ? [`${kept.join(', ')} 已经不在范围里，有人在用，先留着`] : []),
    ].join('；')
    status(true, message)
    if (listing() !== before) this.lab.kernel.record(actor, null, 'lab-sync', id, true, message)
    if (listing() !== before || known() !== beforeStatus) this.lab.kernel.changed(null)
    // Keep backend leases alive, and hand boards someone let go of in the backend to whoever queued for them here.
    for (const name of listed) {
      if (this.lab.locks.held(name)) await this.lab.locks.settle(name)
      else if (this.lab.locks.queue(name).length) this.lab.locks.promote(name)
    }
  }

  /** Take an instance's boards that `drop` names off the list, except held ones, which are returned. */
  private dropBoards(id: string, drop: (name: string) => boolean): string[] {
    const kept: string[] = []
    for (const row of this.lab.kernel.db.prepare('SELECT name FROM boards WHERE lab=?').all(id)) {
      const name = String(row.name)
      if (!drop(name)) continue
      if (this.lab.locks.held(name)) { kept.push(name); continue }
      this.lab.locks.forget(name)
      this.lab.boards.drop(name)
      this.devices.delete(name)
    }
    return kept
  }
}
