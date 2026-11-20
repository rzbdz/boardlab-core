/**
 * The runs boardd does to boards (`Kernel.doing`), kept in its database from start to end: a client that lost its
 * connection follows one by its id, a board shows how its last one ended, and a boardd that starts again finds those a
 * previous boardd left running.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseSync } from 'node:sqlite'
import type { Run, RunStatus } from '../shared/types.ts'

/** The ids a client may choose for a run it starts (`x-boards-run`); any other is replaced by one boardd makes. */
export const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/

/**
 * The run id a request asked for: the first run `Kernel.doing` starts while handling it takes the id (and clears it,
 * so a second run in the same request gets one of its own).
 */
export const requestedRun = new AsyncLocalStorage<{ id: string | null }>()

/** Handle a request under the run id its client chose; one that is not a valid id is ignored (boardd makes its own). */
export function withRunId<T>(id: string | null | undefined, handle: () => T): T {
  return id && RUN_ID.test(id) ? requestedRun.run({ id }, handle) : handle()
}

/** How many ended runs each board keeps. */
const KEPT = 10
/** A run's progress line is written at most this often (the latest one is written when it ends). */
const LINE_MS = 2000

/** A boardd running a run writes down that it still does this often (`Kernel` beats while it runs any). */
export const BEAT_MS = 15_000
/** A run whose boardd has not said so for this long is taken to have lost it (its process hung, or its pid was reused). */
export const STALE_MS = 6 * BEAT_MS

/** A run as kept, with what boardd needs to follow it again: the backend's handle, the process that ran it and when it last said it still does. */
export interface RunRow extends Run { handle: string | null, cancellable: boolean, boot: string, pid: number, beat: string | null }

/** Whether process `pid` is there (EPERM: there, another user's); this process's own pid counts as gone (a boardd before it). */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

export class RunStore {
  private readonly written = new Map<string, number>()
  constructor(private readonly db: DatabaseSync, private readonly now: () => number) {}

  private iso() { return new Date(this.now()).toISOString() }

  start(run: { id: string, boards: string[], kind: string, label: string, by: string, since: string, cancellable: boolean, boot: string, pid: number }) {
    this.db.prepare('INSERT INTO runs(id, kind, label, holder, since, cancellable, status, boot, pid, beat) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(run.id, run.kind, run.label, run.by, run.since, run.cancellable ? 1 : 0, 'running', run.boot, run.pid, this.iso())
    const board = this.db.prepare('INSERT OR IGNORE INTO run_boards(run, board) VALUES(?,?)')
    for (const name of run.boards) board.run(run.id, name)
  }

  /** Take over a run a gone boardd (`from`) left running; false when another process took it first. */
  take(id: string, from: string, boot: string, pid: number): boolean {
    return Number(this.db.prepare("UPDATE runs SET boot=?, pid=?, beat=? WHERE id=? AND boot=? AND status='running'").run(boot, pid, this.iso(), id, from).changes) === 1
  }

  /** Say that boardd `boot` still runs its runs. */
  beat(boot: string) { this.db.prepare("UPDATE runs SET beat=? WHERE boot=? AND status='running'").run(this.iso(), boot) }

  /**
   * Whether the boardd that runs `row` still does: its process is there and it said so lately. A row from a boardd
   * that never says (an older one) goes by its process alone.
   */
  live(row: RunRow, isAlive: (pid: number) => boolean): boolean {
    if (!isAlive(row.pid)) return false
    return row.beat === null || this.now() - Date.parse(row.beat) < STALE_MS
  }

  /**
   * The boards runs of another live boardd hold (a worker being replaced finishing its own): the same boards are busy
   * here too, so nothing starts on them, and their backend leases are kept, until those runs end.
   */
  elsewhere(boot: string, isAlive: (pid: number) => boolean): Map<string, RunRow> {
    const held = new Map<string, RunRow>()
    for (const row of this.leftover(boot)) if (this.live(row, isAlive)) for (const board of row.boards) held.set(board, row)
    return held
  }

  line(id: string, text: string) {
    const at = this.now()
    if (at - (this.written.get(id) ?? 0) < LINE_MS) return
    this.written.set(id, at)
    this.db.prepare('UPDATE runs SET line=? WHERE id=?').run(text, id)
  }

  handle(id: string, handle: string) { this.db.prepare('UPDATE runs SET handle=? WHERE id=?').run(handle, id) }

  end(id: string, status: Exclude<RunStatus, 'running'>, message: string | null, line: string | null) {
    this.written.delete(id)
    this.db.prepare('UPDATE runs SET status=?, message=?, line=COALESCE(?, line), ended_at=? WHERE id=?').run(status, message, line, this.iso(), id)
    // Each board keeps its last few runs.
    for (const board of this.boardsOf(id)) {
      this.db.prepare(`DELETE FROM runs WHERE status != 'running' AND id IN (
        SELECT r.id FROM run_boards b JOIN runs r ON r.id = b.run WHERE b.board = ? ORDER BY r.since DESC, r.rowid DESC LIMIT -1 OFFSET ?)`).run(board, KEPT)
    }
  }

  get(id: string): RunRow | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id)
    return row ? this.toRow(row) : null
  }

  /** Each board's current or last run. */
  latest(): Map<string, Run> {
    const rows = this.db.prepare(`SELECT * FROM (
      SELECT b.board AS board, r.*, ROW_NUMBER() OVER (PARTITION BY b.board ORDER BY r.since DESC, r.rowid DESC) AS n
      FROM run_boards b JOIN runs r ON r.id = b.run) WHERE n = 1`).all()
    const boards = new Map<string, string[]>()
    const ids = rows.map(row => String(row.id))
    for (const row of ids.length ? this.db.prepare(`SELECT run, board FROM run_boards WHERE run IN (${ids.map(() => '?').join(',')})`).all(...ids) : []) {
      const list = boards.get(String(row.run)) ?? []
      list.push(String(row.board)); boards.set(String(row.run), list)
    }
    return new Map(rows.map(row => [String(row.board), toRun(row, boards.get(String(row.id)) ?? [])]))
  }

  /** Runs still marked running by a boardd other than `boot`. */
  leftover(boot: string): RunRow[] {
    return this.db.prepare("SELECT * FROM runs WHERE status='running' AND boot != ? ORDER BY since").all(boot).map(row => this.toRow(row))
  }

  /** A board renamed keeps its runs. */
  rename(from: string, to: string) { this.db.prepare('UPDATE run_boards SET board=? WHERE board=?').run(to, from) }

  private boardsOf(id: string): string[] {
    return this.db.prepare('SELECT board FROM run_boards WHERE run=? ORDER BY board').all(id).map(row => String(row.board))
  }

  private toRow(row: Record<string, unknown>): RunRow {
    return { ...toRun(row, this.boardsOf(String(row.id))), handle: row.handle === null ? null : String(row.handle), cancellable: !!row.cancellable, boot: String(row.boot), pid: Number(row.pid), beat: row.beat === null || row.beat === undefined ? null : String(row.beat) }
  }
}

function toRun(row: Record<string, unknown>, boards: string[]): Run {
  const text = (value: unknown) => value === null || value === undefined ? null : String(value)
  return {
    id: String(row.id), boards, kind: String(row.kind), label: String(row.label), by: String(row.holder), since: String(row.since),
    line: text(row.line), status: String(row.status) as RunStatus, message: text(row.message), endedAt: text(row.ended_at),
  }
}
