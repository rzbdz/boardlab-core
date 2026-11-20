/**
 * Runs a previous boardd left running (its worker died or was replaced while it flashed a board, say): each is followed
 * again to its end when its backend can (`Backend.follow`, by the handle the run reported), or else marked
 * interrupted, so a board never shows a run nobody follows as still going.
 */
import { CancelledError } from './errors.ts'
import type { BoardLab } from './lab.ts'
import type { RunRow } from './runs.ts'

export const INTERRUPTED = 'boardd 在它运行时重启了，没能跟到它结束；后端可能还在做（boardlab show 看板子现在的样子）'

/**
 * Take over every run left running by a boardd that is gone, or that stopped saying it still runs it (hung, or its pid
 * now belongs to another process): a worker being replaced finishes its own runs. Returns the ids followed again and
 * those interrupted.
 */
export function resumeRuns(lab: BoardLab, isAlive: (pid: number) => boolean = lab.kernel.alive): { followed: string[], interrupted: string[] } {
  const kernel = lab.kernel
  const followed: string[] = [], interrupted: string[] = []
  for (const row of kernel.runs.leftover(kernel.boot)) {
    if (kernel.runs.live(row, isAlive)) continue
    if (!kernel.runs.take(row.id, row.boot, kernel.boot, process.pid)) continue
    const how = row.handle ? follower(lab, row) : null
    if (!how) {
      kernel.runs.end(row.id, 'interrupted', INTERRUPTED, null)
      for (const board of row.boards) kernel.record(row.by, board.startsWith('lab:') ? null : board, row.kind, row.label, false, INTERRUPTED)
      for (const board of row.boards) kernel.changed(board.startsWith('lab:') ? null : board)
      interrupted.push(row.id)
      continue
    }
    followed.push(row.id)
    void how().catch(() => {})
  }
  return { followed, interrupted }
}

/** How to follow `row` to its end again, or null when its backend cannot. */
function follower(lab: BoardLab, row: RunRow): (() => Promise<string>) | null {
  const board = row.boards.length === 1 ? row.boards[0]! : null
  if (!board || board.startsWith('lab:')) return null
  let route
  try { route = lab.backends.route(board) } catch { return null }
  const follow = route.backend.follow
  if (!follow) return null
  const detail = `${row.label.replace(/中$/, '')}（boardd 重启后接着跟）`
  return async () => {
    try {
      const output = await lab.kernel.doing([board], row.kind, row.label, row.by, (line, signal) => follow.call(route.backend, route.config, route.target, row.handle!, lab.download.follow(board, line), signal),
        { resume: { id: row.id, since: row.since }, cancellable: row.cancellable })
      lab.kernel.record(row.by, board, row.kind, detail, true)
      return output
    } catch (error) {
      // Not followed at all (the board was taken by another run in between): nobody knows how it ended.
      if (lab.kernel.runs.get(row.id)?.status === 'running') lab.kernel.runs.end(row.id, 'interrupted', INTERRUPTED, null)
      lab.kernel.record(row.by, board, row.kind, detail, false, error instanceof CancelledError ? error.message : (error as Error).message)
      throw error
    } finally { lab.download.ended(board) }
  }
}
