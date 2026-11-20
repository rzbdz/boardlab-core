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

/** A run as kept, with what boardd needs to follow it again: the backend's handle and the process that ran it. */
export interface RunRow extends Run { handle: string | null, cancellable: boolean, boot: string, pid: number }

export class RunStore {
  private readonly written = new Map<string, number>()
  constructor(private readonly db: DatabaseSync, private readonly now: () => number) {}

  private iso() { return new Date(this.now()).toISOString() }

  start(run: { id: string, boards: string[], kind: string, label: string, by: string, since: string, cancellable: boolean, boot: string, pid: number }) {
    this.db.prepare('INSERT INTO runs(id, kind, label, holder, since, cancellable, status, boot, pid) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(run.id, run.kind, run.label, run.by, run.since, run.cancellable ? 1 : 0, 'running', run.boot, run.pid)
    const board = this.db.prepare('INSERT OR IGNORE INTO run_boards(run, board) VALUES(?,?)')
    for (const name of run.boards) board.run(run.id, name)
  }

  /** Take over a run a gone boardd (`from`) left running; false when another process took it first. */
  take(id: string, from: string, boot: string, pid: number): boolean {
    return Number(this.db.prepare("UPDATE runs SET boot=?, pid=? WHERE id=? AND boot=? AND status='running'").run(boot, pid, id, from).changes) === 1
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
    return { ...toRun(row, this.boardsOf(String(row.id))), handle: row.handle === null ? null : String(row.handle), cancellable: !!row.cancellable, boot: String(row.boot), pid: Number(row.pid) }
  }
}

function toRun(row: Record<string, unknown>, boards: string[]): Run {
  const text = (value: unknown) => value === null || value === undefined ? null : String(value)
  return {
    id: String(row.id), boards, kind: String(row.kind), label: String(row.label), by: String(row.holder), since: String(row.since),
    line: text(row.line), status: String(row.status) as RunStatus, message: text(row.message), endedAt: text(row.ended_at),
  }
}
