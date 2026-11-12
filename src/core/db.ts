/**
 * boardd's own SQLite database, the authority on boards, locks and actions. The core's tables are made here; a module
 * makes its own tables when it is set up (see Kernel.schema).
 */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_VERSION = 7

export function openDatabase(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  chmodSync(file, 0o600)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
  if (version > SCHEMA_VERSION) throw new Error('数据库版本高于当前程序，请使用匹配版本。')
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS boards (
      name TEXT PRIMARY KEY, slot INTEGER UNIQUE, serial TEXT, product TEXT, base_mac TEXT, soc TEXT,
      notes TEXT, source TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'unknown', last_seen_at TEXT, lab TEXT, lab_device TEXT
    );
    CREATE TABLE IF NOT EXISTS chips (
      board TEXT NOT NULL REFERENCES boards(name) ON DELETE CASCADE ON UPDATE CASCADE, die TEXT NOT NULL,
      serial_path TEXT, baud INTEGER NOT NULL DEFAULT 115200, alias TEXT, download_usb_path TEXT,
      usb_id TEXT, last_seen_at TEXT, PRIMARY KEY(board, die)
    );
    CREATE TABLE IF NOT EXISTS leases (
      id TEXT PRIMARY KEY, board TEXT NOT NULL, holder TEXT NOT NULL, purpose TEXT NOT NULL,
      token_hash TEXT NOT NULL, started_at TEXT NOT NULL, status TEXT NOT NULL,
      ended_at TEXT, end_reason TEXT, gate_token TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS lease_held ON leases(board) WHERE status = 'held';
    CREATE TABLE IF NOT EXISTS lease_waiters (
      id TEXT PRIMARY KEY, board TEXT NOT NULL, holder TEXT NOT NULL, purpose TEXT NOT NULL, queued_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, board TEXT,
      kind TEXT NOT NULL, detail TEXT, ok INTEGER NOT NULL, message TEXT
    );
    CREATE INDEX IF NOT EXISTS action_board ON actions(board, id);
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, kind TEXT NOT NULL, board TEXT, slot INTEGER,
      summary TEXT NOT NULL, change TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS board_models (
      name TEXT PRIMARY KEY, last_used_at TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 1
    );
    -- Firmware used to be registered here; it now ships in firmware/.
    DROP TABLE IF EXISTS images;
  `)
  // Version 2 gives each lease the token the input gates of the board's serial ports follow.
  addColumn(db, 'leases', 'gate_token', 'TEXT')
  // Version 4 adds boards listed from remote labs, with the lab's own name for each.
  addColumn(db, 'boards', 'lab', 'TEXT')
  addColumn(db, 'boards', 'lab_device', 'TEXT')
  // Version 5 keeps the token of the lease boardd holds in a lab that has leases of its own.
  addColumn(db, 'boards', 'lab_token', 'TEXT')
  // Version 6 keeps the slot a lab board sits in, its second name.
  addColumn(db, 'boards', 'lab_slot', 'TEXT')
  // Version 7 keeps a model someone typed in themselves, so a scan or a lab listing does not replace it.
  addColumn(db, 'boards', 'product_manual', 'INTEGER NOT NULL DEFAULT 0')
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
  return db
}

/** Add a column a table made by an older boardd lacks. */
export function addColumn(db: DatabaseSync, table: string, column: string, declaration: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name))
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const result = fn(); db.exec('COMMIT'); return result }
  catch (error) { db.exec('ROLLBACK'); throw error }
}
