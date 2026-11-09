/**
 * Proposed inventory changes: what a scan or a backend's discovery found, waiting for a person to apply or reject.
 * Whoever proposed a change applies it, so each proposer registers as the owner of its proposals.
 */
import { randomUUID } from 'node:crypto'
import type { Proposal, ProposalKind } from '../shared/types.ts'
import { BoardError } from './errors.ts'
import type { Kernel } from './kernel.ts'
import { str, type Row } from './text.ts'

export interface ProposalOwner {
  owns(proposal: Proposal): boolean
  /** Apply or reject the owner's proposals; `given` holds names people gave, by proposal id. */
  resolve(actor: string, proposals: Proposal[], decision: 'apply' | 'reject', given: Record<string, string>): Promise<void>
}

export const toProposal = (row: Row): Proposal => ({
  id: String(row.id), scanId: String(row.scan_id), kind: row.kind, board: str(row.board), slot: row.slot === null ? null : Number(row.slot),
  summary: String(row.summary), change: JSON.parse(String(row.change)), status: row.status,
})

export class Proposals {
  private readonly owners: ProposalOwner[] = []

  constructor(private readonly k: Kernel) {}

  addOwner(owner: ProposalOwner) { this.owners.push(owner) }

  pending(): Proposal[] { return this.k.db.prepare(`SELECT * FROM proposals WHERE status='pending' ORDER BY slot, rowid`).all().map(toProposal) }

  add(scanId: string, kind: ProposalKind, board: string | null, slot: number | null, summary: string, change: Record<string, unknown>) {
    this.k.db.prepare(`INSERT INTO proposals(id, scan_id, kind, board, slot, summary, change, status) VALUES(?,?,?,?,?,?,?,'pending')`)
      .run(randomUUID(), scanId, kind, board, slot, summary, JSON.stringify(change))
  }

  /** Reject the pending proposals `which` picks: those of an earlier run that a new one replaces. */
  supersede(which: (proposal: Proposal) => boolean) {
    for (const proposal of this.pending()) if (which(proposal)) this.mark(proposal.id, 'rejected')
  }

  mark(id: string, status: 'applied' | 'rejected') { this.k.db.prepare('UPDATE proposals SET status=? WHERE id=?').run(status, id) }

  async resolve(actor: string, ids: string[], decision: 'apply' | 'reject', given: Record<string, string> = {}) {
    const chosen = this.pending().filter(item => ids.includes(item.id))
    if (!chosen.length) throw new BoardError('not-found', '没有待处理的改动建议')
    for (const owner of this.owners) {
      const mine = chosen.filter(proposal => owner.owns(proposal))
      if (mine.length) await owner.resolve(actor, mine, decision, given)
    }
  }
}
