/**
 * What every part of boardlab shares: the database, the clock, the event bus, the action log and settings. Subsystems
 * and modules are built on a kernel and never on each other's internals.
 */
import { EventEmitter } from 'node:events'
import type { DatabaseSync } from 'node:sqlite'
import type { BoardEvent } from '../shared/types.ts'
import { addColumn } from './db.ts'

export interface KernelOptions {
  db: DatabaseSync
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Settings under one prefix, as a module keeps them. */
export interface Settings {
  get(key: string): string | null
  set(key: string, value: string | null): void
  flag(key: string): boolean | null
}

export class Kernel {
  readonly db: DatabaseSync
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly events = new EventEmitter()

  constructor(options: KernelOptions) {
    this.db = options.db
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.events.setMaxListeners(100)
  }

  /** Make a module's tables: `sql` creates them if missing, `columns` adds what tables made by older versions lack. */
  schema(sql: string, columns: Array<[table: string, column: string, declaration: string]> = []) {
    this.db.exec(sql)
    for (const [table, column, declaration] of columns) addColumn(this.db, table, column, declaration)
  }

  iso(offset = 0) { return new Date(this.now() + offset).toISOString() }
  emit(event: BoardEvent) { this.events.emit('event', event) }
  /** Tell everyone watching that a board (or, with null, anything) changed. */
  changed(board: string | null) { this.emit({ type: 'changed', board }) }

  /** Every action anyone takes is logged with who, on what, and how it went. */
  record(actor: string, board: string | null, kind: string, detail: string | null, ok: boolean, message: string | null = null) {
    this.db.prepare('INSERT INTO actions(at, actor, board, kind, detail, ok, message) VALUES(?,?,?,?,?,?,?)')
      .run(this.iso(), actor, board, kind, detail, ok ? 1 : 0, message)
  }

  setting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)
    return row ? String(row.value) : null
  }

  setSetting(key: string, value: string | null) {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key=?').run(key)
    else this.db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }

  /** The settings under `<prefix>.`. */
  settings(prefix: string): Settings {
    const key = (name: string) => `${prefix}.${name}`
    return {
      get: name => this.setting(key(name)),
      set: (name, value) => this.setSetting(key(name), value),
      flag: name => { const value = this.setting(key(name)); return value === null ? null : value === '1' },
    }
  }
}
