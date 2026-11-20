/**
 * boardd's own SQLite database, the authority on boards, locks and actions. The core's tables are made here; a module
 * makes its own tables when it is set up (see Kernel.schema).
 *
 * It is the only copy of the boards' history, leases and feedback, so it is written durably (WAL with
 * `synchronous=FULL`), copied while it runs (`backupDatabase`), and checked when boardd starts: a file that fails its
 * check is moved aside and the newest good copy put in its place (`recoverDatabase`).
 */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { DatabaseRestore } from '../shared/types.ts'

const SCHEMA_VERSION = 9

export interface OpenOptions {
  /** Check the file first and, when it fails, restore it from the newest good copy in this directory (see `recoverDatabase`). */
  backups?: string
  /**
   * Whether a damaged file may be moved aside and restored (default true). False for a process that shares the file
   * with another one still using it (a worker an update starts beside the old one): it refuses to open a damaged file
   * instead, and leaves it to the other process.
   */
  restore?: boolean
  /** Where to say what recovery did; it is loud on purpose. */
  log?: (message: string) => void
}


const RESTORED = 'db.restored'

export function openDatabase(file: string, options: OpenOptions = {}): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const recovered = options.backups ? recoverDatabase(file, options.backups, options.log, { restore: options.restore ?? true }) : null
  const db = new DatabaseSync(file)
  chmodSync(file, 0o600)
  // FULL, not the WAL default of NORMAL: a commit survives a power cut, not only a crash of boardd.
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
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
    -- Version 8: each run boardd does to boards (Kernel.doing), kept past its end and past a restart of boardd.
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, holder TEXT NOT NULL, since TEXT NOT NULL,
      line TEXT, handle TEXT, cancellable INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, message TEXT, ended_at TEXT,
      boot TEXT NOT NULL, pid INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_status ON runs(status);
    CREATE TABLE IF NOT EXISTS run_boards (
      run TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, board TEXT NOT NULL, PRIMARY KEY(board, run)
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
  // Version 9: when the boardd running a run last said it still does (`RunStore.beat`).
  addColumn(db, 'runs', 'beat', 'TEXT')
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
  // A restore loses what changed after the copy: it is written down in the database it made, so boardd reports it (in
  // its state, to the page and `boardlab status`) until someone has seen it, not only in a log nobody reads.
  if (recovered?.corrupt) {
    const record: DatabaseRestore = { at: recovered.at!, backup: recovered.restored, aside: recovered.corrupt, reason: recovered.reason ?? '' }
    db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(RESTORED, JSON.stringify(record))
    db.prepare('INSERT INTO actions(at, actor, board, kind, detail, ok, message) VALUES(?,?,?,?,?,?,?)').run(record.at, 'boardd', null, 'db-restore',
      record.backup ? basename(record.backup) : null, 0, `${record.backup ? `数据库损坏，用备份 ${record.backup} 恢复，这份备份之后的改动丢了` : '数据库损坏，没有可用的备份，用空数据库启动'}；损坏的文件在 ${record.aside}`)
  }
  return db
}

/** The restore boardd made at a start that nobody has acknowledged yet, or null. */
export function restoreRecord(db: DatabaseSync): DatabaseRestore | null {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(RESTORED)
  if (!row) return null
  try { return JSON.parse(String(row.value)) as DatabaseRestore } catch { return null }
}

/** Someone has seen the restore: it is no longer reported. Returns the one that was, or null. */
export function acknowledgeRestore(db: DatabaseSync): DatabaseRestore | null {
  const record = restoreRecord(db)
  db.prepare('DELETE FROM settings WHERE key=?').run(RESTORED)
  return record
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

/** A time as it goes into a file name: `2026-11-19T21-35-00-123Z` (UTC; sorts in time order). */
export function fileStamp(at = new Date()): string { return at.toISOString().replace(/[:.]/g, '-') }

/** What SQLite says of a file that is damaged, as opposed to one that is busy or unreadable for now. */
const DAMAGED = /not a database|malformed|corrupt|disk image/i

/**
 * Whether a database file opens and passes `PRAGMA quick_check`; `reason` says why not. `damaged` is false when it could
 * not be checked for another reason (another process holding it, permissions): such a file is never moved aside.
 */
export function checkDatabase(file: string, readOnly = false): { ok: boolean, damaged: boolean, reason: string | null } {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly })
    db.exec('PRAGMA busy_timeout=5000')
    const rows = db.prepare('PRAGMA quick_check').all().map(row => String(Object.values(row)[0]))
    return rows.length === 1 && rows[0] === 'ok' ? { ok: true, damaged: false, reason: null } : { ok: false, damaged: true, reason: rows.slice(0, 5).join('; ') || 'quick_check 没有结果' }
  } catch (error) {
    const reason = (error as Error).message
    return { ok: false, damaged: DAMAGED.test(reason), reason }
  } finally {
    try { db?.close() } catch { /* a file that never opened */ }
  }
}

/** The copies `backupDatabase` made of `file` in `dir`, newest first. */
export function listBackups(file: string, dir: string): string[] {
  const prefix = `${basename(file).replace(/\.sqlite$/, '')}-`
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.startsWith(prefix) && name.endsWith('.sqlite')).sort().reverse().map(name => join(dir, name))
}

/** What `recoverDatabase` did: the damaged file's new name, the copy put in its place, when, and what the check said. */
export interface Recovery { corrupt: string | null, restored: string | null, at?: string, reason?: string | null }

/**
 * Check `file` before boardd opens it. One that does not open or fails `PRAGMA quick_check` is moved aside (with its
 * `-wal` and `-shm`) as `<file>.corrupt-<stamp>`, never deleted, and the newest copy in `backups` that passes the same
 * check is put in its place; with none, boardd starts with an empty database. Says what it did through `log`.
 * With `restore: false` (another process still has the file open) a damaged file is left as it is and this throws:
 * moving it aside under the other process would leave the two on different databases.
 * Returns what happened, for tests and logs.
 */
export function recoverDatabase(file: string, backups: string, log: (message: string) => void = message => console.error(message), options: { restore?: boolean } = {}): Recovery {
  if (!existsSync(file)) return { corrupt: null, restored: null }
  // Read-only, so checking never changes the files (closing a writable connection would fold or drop the -wal).
  const check = checkDatabase(file, true)
  if (check.ok) return { corrupt: null, restored: null }
  if (!check.damaged) { log(`boardd 没能检查数据库 ${file}（${check.reason}），照常打开`); return { corrupt: null, restored: null } }
  if (options.restore === false) {
    throw new Error(`数据库 ${file} 没有通过检查（${check.reason}）；另一个 boardd 还在用它，这个不去动它，不启动`)
  }
  const at = new Date()
  const aside = `${file}.corrupt-${fileStamp(at)}`
  renameSync(file, aside)
  for (const suffix of ['-wal', '-shm']) if (existsSync(file + suffix)) renameSync(file + suffix, aside + suffix)
  const banner = '!!!!!!!! boardd 数据库损坏 !!!!!!!!'
  log(`${banner}\n${file} 没有通过检查（${check.reason}），已经移到 ${aside}`)
  for (const backup of listBackups(file, backups)) {
    const good = checkDatabase(backup, true)
    if (!good.ok) { log(`备份 ${backup} 也没有通过检查（${good.reason}），跳过`); continue }
    const temp = `${file}.restoring`
    copyFileSync(backup, temp)
    renameSync(temp, file)
    chmodSync(file, 0o600)
    log(`${banner}\n已经用备份 ${backup} 恢复了 ${file}；这份备份之后的改动丢了，损坏的文件留在 ${aside}`)
    return { corrupt: aside, restored: backup, at: at.toISOString(), reason: check.reason }
  }
  log(`${banner}\n没有可用的备份：boardd 用一个空数据库启动，损坏的文件留在 ${aside}`)
  return { corrupt: aside, restored: null, at: at.toISOString(), reason: check.reason }
}

export interface BackupOptions {
  /** How many copies to keep (newest first). */
  keep?: number
  now?: () => Date
}

/**
 * Copy the running database into `dir` as `<name>-<stamp>.sqlite` with `VACUUM INTO`: a consistent copy taken while
 * boardd keeps working, written under a temporary name and renamed into place, so a copy that exists is whole. Keeps
 * the newest `keep` (5). Only one process copies at a time (a lock file in `dir`, taken over from a process that died).
 * Returns the copy, or null when another process was copying. `VACUUM INTO` runs on this thread: for a database of
 * this size it takes milliseconds, so the caller runs it off the request path rather than in a worker.
 */
export function backupDatabase(db: DatabaseSync, file: string, dir: string, options: BackupOptions = {}): string | null {
  const keep = Math.max(1, options.keep ?? 5)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const unlock = lockDir(dir)
  if (!unlock) return null
  try {
    const name = `${basename(file).replace(/\.sqlite$/, '')}-${fileStamp(options.now?.() ?? new Date())}.sqlite`
    const target = join(dir, name), temp = join(dir, `.${name}.tmp`)
    // A copy a process died writing: nobody else copies while the lock is held.
    for (const leftover of readdirSync(dir).filter(item => item.endsWith('.tmp'))) rmSync(join(dir, leftover), { force: true })
    db.prepare('VACUUM INTO ?').run(temp)
    chmodSync(temp, 0o600)
    renameSync(temp, target)
    for (const old of listBackups(file, dir).slice(keep)) rmSync(old, { force: true })
    return target
  } finally { unlock() }
}

/** Take `<dir>/.lock` for this process, or null when a live process holds it. A lock left by a dead process is taken over. */
function lockDir(dir: string): (() => void) | null {
  const path = join(dir, '.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
      return () => { try { if (readFileSync(path, 'utf8').trim() === String(process.pid)) rmSync(path, { force: true }) } catch { /* gone already */ } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let pid = NaN, age = 0
      try { pid = Number(readFileSync(path, 'utf8').trim()); age = Date.now() - statSync(path).mtimeMs } catch { continue }
      if (alive(pid) && age < 30 * 60_000) return null
      rmSync(path, { force: true })
    }
  }
  return null
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

export interface BackupSchedule {
  /** Between copies (6 hours). */
  everyMs?: number
  /** The first copy, a little after start so it is off the start's path. */
  firstMs?: number
  /**
   * A start within this long of the newest copy makes none (1 hour): a worker restarting again and again must not push
   * the older copies out of the five kept.
   */
  minGapMs?: number
  keep?: number
  log?: (message: string) => void
}

/** Copy the database a little after start and every `everyMs` after; returns the stop. A failed copy is logged, never thrown. */
export function scheduleBackups(db: DatabaseSync, file: string, dir: string, options: BackupSchedule = {}): () => void {
  const log = options.log ?? (message => console.error(message))
  const everyMs = options.everyMs ?? 6 * 3600_000, minGapMs = options.minGapMs ?? 3600_000
  const run = (first: boolean) => {
    try {
      const newest = listBackups(file, dir)[0]
      if (first && newest && Date.now() - statSync(newest).mtimeMs < minGapMs) return
      backupDatabase(db, file, dir, { keep: options.keep })
    } catch (error) { log(`boardd 没能备份数据库到 ${dir}：${(error as Error).message}`) }
  }
  const first = setTimeout(() => run(true), options.firstMs ?? 5_000)
  const every = setInterval(() => run(false), everyMs)
  first.unref(); every.unref()
  return () => { clearTimeout(first); clearInterval(every) }
}
