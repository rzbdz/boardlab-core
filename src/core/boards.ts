/**
 * The inventory: every board boardlab knows, whichever backend it is on, and its chips (a serial port and a download
 * port each). What a backend knows about a board right now (online, its lab's view) is added by views.
 */
import type { Action, Board, BoardDetail, BoardMode, Chip, Lease } from '../shared/types.ts'
import { transaction } from './db.ts'
import { BoardError } from './errors.ts'
import type { BoardLab } from './lab.ts'
import { BOARD_NAME, str, type Row } from './text.ts'
import { formatToml, type TomlTable } from './toml.ts'

/** What a view is told about a board besides its record: the backend it is on. */
export interface BoardRecord { backend: string, device: string | null }
export type BoardView = (board: Board, record: BoardRecord) => void

export interface NewBoard {
  name: string
  slot?: number | null
  product?: string | null
  chips?: Array<{ die?: string, serialPath?: string | null, alias?: string | null, downloadUsbPath?: string | null, usbId?: string | null }>
}

const toChip = (row: Row): Chip => ({
  board: String(row.board), die: String(row.die), serialPath: str(row.serial_path), baud: Number(row.baud), alias: str(row.alias),
  downloadUsbPath: str(row.download_usb_path), usbId: str(row.usb_id), lastSeenAt: str(row.last_seen_at), online: false, gateError: null,
})
export const toAction = (row: Row): Action => ({
  id: Number(row.id), at: String(row.at), actor: String(row.actor), board: str(row.board), kind: String(row.kind),
  detail: str(row.detail), ok: row.ok === 1, message: str(row.message),
})

/** The SoC a product name says, for the products whose names do. */
export function socOf(product: string): string | null {
  if (/^k3[_-]/i.test(product)) return 'k3'
  if (/^k1[_-]/i.test(product)) return 'k1'
  return null
}

export class Boards {
  private readonly views: BoardView[] = []

  constructor(private readonly lab: BoardLab) {
    lab.locks.addTarget(target => this.exists(target))
  }

  /** Add to what boards show: a backend's live view of them. */
  addView(view: BoardView) { this.views.push(view) }

  exists(name: string): boolean { return !!this.lab.kernel.db.prepare('SELECT 1 FROM boards WHERE name=?').get(name) }

  /** The backend a board is on: its lab, or the default backend for boards with none. */
  record(name: string): BoardRecord | null {
    const row = this.lab.kernel.db.prepare('SELECT lab, lab_device FROM boards WHERE name=?').get(name)
    return row ? { backend: str(row.lab) ?? this.lab.backends.defaultId, device: str(row.lab_device) } : null
  }

  list(): Board[] {
    const db = this.lab.kernel.db
    const chips = db.prepare('SELECT * FROM chips ORDER BY board, die').all().map(toChip)
    const leases = new Map(this.lab.locks.holders().map(lease => [lease.board, lease]))
    const waiters = this.lab.locks.waiters()
    return db.prepare('SELECT * FROM boards ORDER BY slot IS NULL, slot, name').all().map(row => {
      const name = String(row.name)
      const record: BoardRecord = { backend: str(row.lab) ?? this.lab.backends.defaultId, device: str(row.lab_device) }
      const slotRef = row.slot !== null ? `slot:${Number(row.slot)}` : str(row.lab_slot) ? `${String(row.lab)}/${String(row.lab_slot)}` : null
      const board: Board = {
        name, slot: row.slot === null ? null : Number(row.slot), slotRef, serial: str(row.serial), product: str(row.product),
        baseMac: str(row.base_mac), soc: str(row.soc), notes: str(row.notes), source: row.source as Board['source'],
        mode: row.mode as BoardMode, lastSeenAt: str(row.last_seen_at), backend: record.backend,
        chips: chips.filter(chip => chip.board === name).map(chip => ({ ...chip })), lease: leases.get(name) ?? null,
        waiters: waiters.filter(waiter => waiter.board === name), busy: this.lab.kernel.busy.get(name) ?? null, lab: null,
      }
      for (const view of this.views) view(board, record)
      return board
    })
  }

  get(name: string): Board {
    const board = this.list().find(item => item.name === name)
    if (!board) throw new BoardError('not-found', `没有这块板：${name}`)
    return board
  }

  /**
   * The board a reference names: its name, or its slot — `slot:5` here, `<lab>/<host>/s3` in a lab, or the shorter
   * `<host>/s3` while only one lab has that host. A reference to a slot with no board is returned as it is (a local
   * `slot:N` is a lock target of its own).
   */
  resolve(ref: string): string {
    if (this.exists(ref) || !ref) return ref
    const db = this.lab.kernel.db
    const local = ref.match(/^slot:(\d+)$/)
    if (local) return str(db.prepare('SELECT name FROM boards WHERE slot=?').get(Number(local[1]))?.name) ?? ref
    if (!ref.includes('/')) return ref
    const rows = db.prepare('SELECT name, lab, lab_slot FROM boards WHERE lab_slot IS NOT NULL').all()
      .filter(row => `${String(row.lab)}/${String(row.lab_slot)}` === ref || String(row.lab_slot) === ref)
    if (rows.length > 1) throw new BoardError('invalid', `${ref} 在几个实验室里都有：${rows.map(row => `${String(row.lab)}/${ref}`).join('、')}，写全`)
    if (!rows.length) throw new BoardError('not-found', `没有槽位 ${ref}（boardlab list 列出各板的槽位）`)
    return String(rows[0]!.name)
  }

  /** One of a board's chips: the one named, or its first. */
  chip(board: string, die?: string): Chip {
    const chips = this.get(board).chips
    const chip = die ? chips.find(item => item.die === die) : chips[0]
    if (!chip) throw new BoardError('not-found', die ? `${board} 没有 ${die}` : `${board} 没有登记串口`)
    return chip
  }

  detail(name: string): BoardDetail {
    return {
      board: this.get(name),
      actions: this.lab.kernel.db.prepare('SELECT * FROM actions WHERE board=? ORDER BY id DESC LIMIT 100').all(name).map(toAction),
      leases: this.lab.locks.recent(50, name),
    }
  }

  actions(limit: number): Action[] { return this.lab.kernel.db.prepare('SELECT * FROM actions ORDER BY id DESC LIMIT ?').all(limit).map(toAction) }
  leases(limit: number): Lease[] { return this.lab.locks.recent(limit) }

  /** Register a board by hand; its chips' serial ports and download ports are whatever the person states. */
  add(actor: string, input: NewBoard) {
    if (!BOARD_NAME.test(input.name)) throw new BoardError('invalid', `板名不合法：${input.name}`)
    const db = this.lab.kernel.db
    transaction(db, () => {
      if (this.exists(input.name)) throw new BoardError('conflict', `已有板子 ${input.name}`)
      if (input.slot != null && db.prepare('SELECT 1 FROM boards WHERE slot=?').get(input.slot)) throw new BoardError('conflict', `槽位 ${input.slot} 已有别的板子`)
      const product = input.product ?? null
      db.prepare(`INSERT INTO boards(name, slot, product, soc, source, product_manual) VALUES(?,?,?,?,'manual',?)`).run(input.name, input.slot ?? null, product, product ? socOf(product) : null, product ? 1 : 0)
      ;(input.chips ?? []).forEach((chip, index) => {
        db.prepare('INSERT INTO chips(board, die, serial_path, alias, download_usb_path, usb_id) VALUES(?,?,?,?,?,?)')
          .run(input.name, chip.die ?? `die${index}`, chip.serialPath ?? null, chip.alias ?? null, chip.downloadUsbPath ?? null, chip.usbId ?? null)
      })
      this.rememberModel(product)
      this.lab.kernel.record(actor, input.name, 'add', input.slot != null ? `槽位 ${input.slot}` : null, true)
    })
    this.lab.kernel.changed(input.name)
  }

  /** The board's name, while nobody holds it. */
  free(name: string): string {
    const held = this.lab.locks.held(name)
    if (held) throw new BoardError('locked', `${name} 正被 ${held.holder} 使用`)
    return name
  }

  /** Take a board off the list, once nobody holds it; a backend with a registry of its own forgets it there first. */
  async remove(actor: string, name: string) {
    const board = this.get(this.free(name))
    const detail = await this.lab.backends.release(actor, board)
    transaction(this.lab.kernel.db, () => { this.lab.locks.forget(name); this.drop(name) })
    this.lab.kernel.record(actor, name, 'remove', detail, true)
    this.lab.kernel.changed(name)
  }

  /** Delete a board's record, chips included. */
  drop(name: string) { this.lab.kernel.db.prepare('DELETE FROM boards WHERE name=?').run(name) }

  update(actor: string, name: string, patch: { notes?: string | null, slot?: number | null, product?: string | null }) {
    if (this.get(name).lab && patch.slot !== undefined) throw new BoardError('invalid', `${name} 在实验室里，没有控制槽位`)
    const db = this.lab.kernel.db
    if (patch.notes !== undefined) db.prepare('UPDATE boards SET notes=? WHERE name=?').run(patch.notes, name)
    if (patch.slot !== undefined) {
      try { db.prepare('UPDATE boards SET slot=? WHERE name=?').run(patch.slot, name) }
      catch { throw new BoardError('conflict', `槽位 ${patch.slot} 已有别的板子`) }
    }
    if (patch.product !== undefined) {
      const product = patch.product?.trim() || null
      db.prepare('UPDATE boards SET product=?, soc=?, product_manual=? WHERE name=?').run(product, product ? socOf(product) : null, product ? 1 : 0, name)
      this.rememberModel(product)
    }
    this.lab.kernel.record(actor, name, 'edit', JSON.stringify(patch), true)
    this.lab.kernel.changed(name)
  }

  /** Models people typed in themselves, most recently used first: the page's dropdown. */
  models(): string[] {
    return this.lab.kernel.db.prepare('SELECT name FROM board_models ORDER BY last_used_at DESC, uses DESC, name').all().map(row => String(row.name))
  }

  /** Remember a model someone typed in, so it is offered next time. */
  private rememberModel(product: string | null) {
    if (!product) return
    this.lab.kernel.db.prepare(`INSERT INTO board_models(name, last_used_at, uses) VALUES(?,?,1)
      ON CONFLICT(name) DO UPDATE SET last_used_at=excluded.last_used_at, uses=uses+1`).run(product, this.lab.kernel.iso())
  }

  setMode(name: string, mode: BoardMode) { this.lab.kernel.db.prepare('UPDATE boards SET mode=? WHERE name=?').run(mode, name) }

  upsertChip(board: string, die: string, fields: Record<string, unknown>) {
    const db = this.lab.kernel.db
    db.prepare('INSERT INTO chips(board, die) VALUES(?,?) ON CONFLICT(board, die) DO NOTHING').run(board, die)
    for (const [column, value] of Object.entries(fields)) {
      if (!/^[a-z_]+$/.test(column)) throw new Error(`chip column ${column}`)
      db.prepare(`UPDATE chips SET ${column}=? WHERE board=? AND die=?`).run(value as string | null, board, die)
    }
  }

  /** Chips follow through the foreign key; the lock, the queue, the actions and the proposals are carried over too. */
  rename(from: string, to: string) {
    const db = this.lab.kernel.db
    db.prepare('UPDATE boards SET name=? WHERE name=?').run(to, from)
    db.prepare('UPDATE actions SET board=? WHERE board=?').run(to, from)
    db.prepare('UPDATE proposals SET board=? WHERE board=?').run(to, from)
    this.lab.locks.rename(from, to)
  }

  /** The boards registered by hand or by scans, as TOML; boards listed from a backend are not kept by hand. */
  exportToml(): string {
    const boards: TomlTable = {}
    for (const board of this.list().filter(item => !item.lab)) {
      const table: TomlTable = {}
      if (board.slot !== null) table.slot = board.slot
      if (board.serial) table.board_serial = board.serial
      if (board.product) table.product_name = board.product
      if (board.baseMac) table.base_mac = board.baseMac
      for (const chip of board.chips) {
        const hints: TomlTable = { baud: chip.baud }
        if (chip.alias) hints.serial_alias = chip.alias
        if (chip.serialPath) hints.serial_device = chip.serialPath
        if (chip.downloadUsbPath) hints.download_usb_path = chip.downloadUsbPath
        if (chip.usbId) hints.usb_vid_pid = chip.usbId
        table[chip.die] = hints
      }
      boards[board.name] = table
    }
    return `# Exported by boardd at ${this.lab.kernel.iso()}. boardd's database is the authority.\nschema_version = 2\n\n${formatToml({ boards })}`
  }
}
