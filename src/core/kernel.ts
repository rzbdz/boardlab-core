/**
 * What every part of boardlab shares: the database, the clock, the event bus, the action log and settings. Subsystems
 * and modules are built on a kernel and never on each other's internals.
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { DatabaseSync } from 'node:sqlite'
import type { BoardEvent, Busy } from '../shared/types.ts'
import { BoardError, BusyError, CancelledError } from './errors.ts'
import { addColumn } from './db.ts'
import { alive, BEAT_MS, requestedRun, RunStore } from './runs.ts'

/** What a run is told about itself: its id, and how to report the backend's own handle on it (`Backend.follow`). */
export interface RunContext { id: string, handle(handle: string): void }

export interface KernelOptions {
  db: DatabaseSync
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Whether a process is there (tests stand in for other boardd processes). */
  alive?: (pid: number) => boolean
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
  /** This process's own id: a client that reconnects and sees another one knows boardd restarted in between. */
  readonly boot = randomUUID()
  /** Every run `doing` does, from its start to its end, kept in the database. */
  readonly runs: RunStore
  /** Whether a process is there: a run another boardd runs counts while its process does. */
  readonly alive: (pid: number) => boolean

  constructor(options: KernelOptions) {
    this.db = options.db
    this.now = options.now ?? Date.now
    this.alive = options.alive ?? alive
    this.runs = new RunStore(this.db, this.now)
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.events.setMaxListeners(100)
  }

  /** What is being done to each board right now (`doing`). */
  readonly busy = new Map<string, Busy>()
  /** The lease each of them runs under (null: it holds its boards until it ends), and how to stop it. */
  private readonly running = new Map<Busy, { lease: string | null, stop: AbortController, targets: string[] }>()
  private beating: NodeJS.Timeout | null = null

  /**
   * What is being done to `target` by anyone: a run of this boardd, or one another live boardd runs (a worker being
   * replaced finishes its own runs while the new one serves). Both keep the board busy here, so nothing else starts on
   * it and its backend lease is kept until the run ends. Only `busy` is this process's own.
   */
  occupied(target: string): Busy | null {
    const own = this.busy.get(target)
    if (own) return own
    const row = this.runs.elsewhere(this.boot, this.alive).get(target)
    return row ? { id: row.id, kind: row.kind, label: row.label, by: row.by, since: row.since, line: row.line, cancellable: row.cancellable } : null
  }

  /** Every target someone's run keeps busy, this boardd's and other live ones' (`occupied`). */
  occupiedAll(): Map<string, Busy> {
    const all = new Map<string, Busy>()
    for (const [board, row] of this.runs.elsewhere(this.boot, this.alive)) all.set(board, { id: row.id, kind: row.kind, label: row.label, by: row.by, since: row.since, line: row.line, cancellable: row.cancellable })
    for (const [board, busy] of this.busy) all.set(board, busy)
    return all
  }

  /** While this boardd runs anything it says so in the database every BEAT_MS, so another boardd can tell it from a hung or gone one. */
  private beatWhileRunning() {
    if (this.running.size && !this.beating) {
      this.beating = setInterval(() => { try { this.runs.beat(this.boot) } catch { /* the database closed: the process is going */ } }, BEAT_MS)
      this.beating.unref()
    } else if (!this.running.size && this.beating) {
      clearInterval(this.beating); this.beating = null
    }
  }

  /**
   * Do `run` to `boards` (or to a lab, as `lab:<id>`), shown as busy on each of them while it runs (with its progress lines, through the `line`
   * it is given). A board already busy is refused, so two operations never overlap on one board. One done under a lock
   * (`lease`) holds the boards only as long as the lock: once it is released or stolen (`leaseEnded`) the boards are
   * free for the next holder and `run`'s signal aborts. One without a lease (a load or a flash, which must not be left
   * halfway) keeps its boards busy until it ends, whatever happens to the lock.
   *
   * `cancellable` (what the run's backend reports) says the run honours its signal: `cancel` then aborts it with a
   * CancelledError, and its boards stay busy until the run returns, so the backend ends what it was doing first and the
   * board's state is known. A run that fails after a cancel fails with that CancelledError; one that finished anyway
   * (its backend was already past the last step) returns what it did.
   */
  async doing<T>(boards: string[], kind: string, label: string, by: string, run: (line: (text: string) => void, signal: AbortSignal, context: RunContext) => Promise<T>,
    options: { lease?: string | null, cancellable?: boolean, resume?: { id: string, since: string } } = {}): Promise<T> {
    const taken = boards.find(board => this.occupied(board))
    if (taken) {
      const now = this.occupied(taken)!
      throw new BusyError(`${taken} 正在${now.label.replace(/中$/, '')}（${now.by}，${now.since.slice(11, 19)} 开始），等它完成`)
    }
    // The run's id: the one its client chose for the request (`x-boards-run`, once per request), else a new one. An id
    // already used is refused, never joined to the run that had it.
    const asked = options.resume ? null : requestedRun.getStore()
    const id = options.resume?.id ?? asked?.id ?? randomUUID()
    if (asked) asked.id = null
    if (!options.resume && this.runs.get(id)) throw new BoardError('conflict', `运行编号 ${id} 已经用过了；换一个`)
    const entry: Busy = { id, kind, label, by, since: options.resume?.since ?? this.iso(), line: null, cancellable: options.cancellable ?? false }
    // A run followed again (`resumeRuns`) was taken over already; a new one is written down from its start.
    if (!options.resume) this.runs.start({ id, boards, kind, label, by, since: entry.since, cancellable: entry.cancellable, boot: this.boot, pid: process.pid })
    for (const board of boards) this.busy.set(board, entry)
    const stop = new AbortController()
    this.running.set(entry, { lease: options.lease ?? null, stop, targets: boards })
    this.beatWhileRunning()
    const changed = () => { if (boards.length === 1) this.changed(boards[0]!); else this.changed(null) }
    changed()
    const cancelled = () => stop.signal.aborted && stop.signal.reason instanceof CancelledError && !stop.signal.reason.refused ? stop.signal.reason : null
    try {
      const result = await run(text => { entry.line = text; this.runs.line(id, text); changed() }, stop.signal, { id, handle: handle => this.runs.handle(id, handle) })
      this.runs.end(id, 'succeeded', said(result), entry.line)
      return result
    } catch (error) {
      const reason = cancelled()
      const thrown = reason && !(error instanceof CancelledError) ? reason : error
      this.runs.end(id, thrown instanceof CancelledError ? 'cancelled' : 'failed', (thrown as Error).message ?? String(thrown), entry.line)
      throw thrown
    } finally {
      this.running.delete(entry)
      this.beatWhileRunning()
      const freed = boards.filter(board => this.busy.get(board) === entry)
      for (const board of freed) this.busy.delete(board)
      changed()
      for (const board of freed) for (const listener of this.idles) listener(board)
    }
  }

  private readonly idles: Array<(target: string) => void> = []
  /** Told each time a run ends and its board is no longer busy: what waited for the run to end (a lease to give back) goes on. */
  onIdle(listener: (target: string) => void) { this.idles.push(listener) }

  /**
   * A person stepping in on a board for one operation (`Locks.takeOver`): whatever runs on it stops, as it would if the
   * lock had ended, and the board is free once the run has returned. A run that must not be left halfway (a flash that
   * outlives its lock) is refused rather than stopped. A run another boardd makes only that process can stop.
   */
  async stopForTakeover(target: string, by: string): Promise<void> {
    const entry = this.busy.get(target)
    if (!entry) {
      const other = this.occupied(target)
      if (other) throw new BoardError('conflict', `${target} 正在${other.label.replace(/中$/, '')}，由另一个 boardd 进程在做，这里接管不了；等它结束`)
      return
    }
    const run = this.running.get(entry)
    // A run without a lease is one that must not be left halfway (a load or a flash): it is not stopped for anyone.
    if (!run || run.lease === null) throw new BoardError('conflict', `${target} 正在${entry.label.replace(/中$/, '')}，这一步不能中途停下，等它完成`)
    const ended = new Promise<void>(resolve => {
      const listener = (board: string) => {
        if (board !== target) return
        const at = this.idles.indexOf(listener)
        if (at >= 0) this.idles.splice(at, 1)
        resolve()
      }
      this.idles.push(listener)
    })
    run.stop.abort(new CancelledError(`${target} 的${entry.label.replace(/中$/, '')}被 ${by} 手动接管停下了`))
    await ended
  }

  /**
   * Stop what is being done to `target` (a board, or `lab:<id>`), whatever kind of operation it is: its run's signal
   * aborts with a CancelledError. Throws when nothing runs there, or when what runs cannot be stopped halfway. The
   * boards stay busy until the run has ended.
   *
   * `answered` settles once the run's backend has answered the cancel (`CancelledError.answer`): it rejects with the
   * backend's reason when the backend refused to stop, and the run then goes on to its end. Asked again, the same
   * answer comes back.
   */
  cancel(target: string, by: string): { message: string, busy: Busy, targets: string[], answered: Promise<void> } {
    const entry = this.busy.get(target)
    const run = entry ? this.running.get(entry) : undefined
    if (!entry || !run) {
      const other = this.occupied(target)
      // A worker being replaced still runs it: only that process can stop it, and it goes on to its end there.
      if (other) throw new BoardError('conflict', `${target} 正在${other.label.replace(/中$/, '')}，由升级前的 boardd 进程在做，这里停不了；等它结束（几分钟内会交给新进程接着跟）`)
      throw new BoardError('conflict', `${target} 没有在做什么，不用取消`)
    }
    const what = entry.label.replace(/中$/, '')
    if (!entry.cancellable) throw new BoardError('invalid', `${target} 正在${what}，这一步不能中途取消，等它结束`)
    const board = target.startsWith('lab:') ? null : target
    let answered: Promise<void>
    if (!run.stop.signal.aborted) {
      const reason = new CancelledError(`已取消：${target} 的${what}被 ${by} 取消了`)
      run.stop.abort(reason)
      answered = reason.answered()
      answered.then(() => this.record(by, board, 'cancel', entry.label, true, null), error => this.record(by, board, 'cancel', entry.label, false, (error as Error).message))
    } else {
      const reason = run.stop.signal.reason
      answered = reason instanceof CancelledError ? reason.answered() : Promise.resolve()
    }
    return { message: `让 ${target} 的${what}停下：正在做的那一步结束后就停`, busy: entry, targets: run.targets, answered }
  }

  /**
   * What a module runs outside `doing` and can stop (a scan over several boards, say): asked, in turn, to cancel what
   * it does to a target. Each answers with a message when it stopped something there, or null when it runs nothing
   * there. `POST /api/cancel` asks them after the runs `doing` keeps.
   */
  private readonly cancellers: Array<(target: string, by: string) => string | null> = []
  addCanceller(canceller: (target: string, by: string) => string | null) { this.cancellers.push(canceller) }
  /** Ask the modules' cancellers to stop what they do to `target`; null when none runs anything there. */
  cancelElsewhere(target: string, by: string): string | null {
    for (const canceller of this.cancellers) { const said = canceller(target, by); if (said) return said }
    return null
  }

  /** A lock ended: what ran under it no longer keeps its boards busy, and is told to stop. */
  leaseEnded(lease: string) {
    for (const [entry, run] of this.running) {
      if (run.lease !== lease) continue
      this.running.delete(entry)
      this.beatWhileRunning()
      const boards = [...this.busy].filter(([, busy]) => busy === entry).map(([board]) => board)
      for (const board of boards) this.busy.delete(board)
      run.stop.abort(new BoardError('locked', `${boards.join('、') || '板子'}的锁已经释放或被抢走，${entry.label.replace(/中$/, '')}停下了`))
      if (boards.length === 1) this.changed(boards[0]!); else this.changed(null)
    }
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

  /** Record an undo with the module being set up now, if any (`BoardLab` sets this to its loader). */
  track(undo: () => void | Promise<void>) { this.recordUndo?.(undo) }
  /** Set by `BoardLab`: its loader records a registration made while a module's setup runs. */
  recordUndo: ((undo: () => void | Promise<void>) => void) | null = null

  setting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)
    return row ? String(row.value) : null
  }

  setSetting(key: string, value: string | null) {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key=?').run(key)
    else this.db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }

  /**
   * The settings under `<prefix>.`. A module that renamed itself keeps what it had stored under its old name: its
   * catalog entry's `was` names those too, and `settings('boardctrl.site', ['bsp.site'])` reads and writes the settings
   * the module had, moving them on the first write rather than losing them on an upgrade.
   */
  settings(prefix: string, previous: string[] = []): Settings {
    const key = (name: string) => `${prefix}.${name}`
    const older = (name: string) => previous.map(old => `${old}.${name}`)
    const read = (name: string): string | null => {
      const own = this.setting(key(name))
      if (own !== null) return own
      for (const candidate of older(name)) { const value = this.setting(candidate); if (value !== null) return value }
      return null
    }
    return {
      get: read,
      set: (name, value) => {
        this.setSetting(key(name), value)
        // What the old name held is the same setting: it goes, so a later read does not answer with a stale one.
        for (const candidate of older(name)) if (this.setting(candidate) !== null) this.setSetting(candidate, null)
      },
      flag: name => { const value = read(name); return value === null ? null : value === '1' },
    }
  }
}

/** What a run that succeeded said, as its run keeps it: its text, or its `output`, cut to the end. */
function said(result: unknown): string | null {
  const text = typeof result === 'string' ? result : typeof (result as { output?: unknown })?.output === 'string' ? (result as { output: string }).output : null
  return text === null ? null : text.length > 4000 ? `…${text.slice(-4000)}` : text
}
