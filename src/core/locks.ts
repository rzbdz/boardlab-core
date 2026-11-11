/**
 * Board locks. People and agents share one set: a lock is needed to reset, boot or type on a board, it lasts until it is
 * released or stolen, and a busy board can be queued for. What lives outside the lock table follows each lock through
 * followers (a serial port's input gate, a backend's own lease), registered by whoever keeps it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Lease, LockResult, Waiter } from '../shared/types.ts'
import { transaction } from './db.ts'
import { BoardError } from './errors.ts'
import type { Kernel } from './kernel.ts'
import { HOLDER, isHuman, str, type Row } from './text.ts'

/** Who asks: a holder, with the lock's token (people may instead be matched by name). */
export interface Caller { holder: string, token?: string | null }
export type HeldLease = Lease & { tokenHash: string, gateToken: string }

/** Something kept in step with a lock: a serial port's input gate, a backend's own lease. */
export interface LockFollower {
  /** Bring it in step with the target's lock as it is when this runs; resolves with why it could not, or null. */
  follow(target: string): Promise<string | null>
  /** A binding follower failing on a fresh lock refuses the lock (a backend that would not lease the board). */
  binding?: boolean
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const newToken = () => randomBytes(24).toString('base64url')

export const toLease = (row: Row): Lease => ({
  id: String(row.id), board: String(row.board), holder: String(row.holder), purpose: String(row.purpose),
  startedAt: String(row.started_at), status: row.status, endedAt: str(row.ended_at), endReason: str(row.end_reason),
})
export const toWaiter = (row: Row): Waiter => ({ id: String(row.id), board: String(row.board), holder: String(row.holder), purpose: String(row.purpose), queuedAt: String(row.queued_at) })

export class Locks {
  private readonly waiting = new Map<string, (result: LockResult) => void>()
  private readonly targets: Array<(target: string) => boolean> = []
  private readonly occupants: Array<(target: string) => string | null> = []
  private readonly followers: LockFollower[] = []
  private readonly endings: Array<(target: string) => void> = []
  private readonly runs = new Map<string, { tail: Promise<string | null>, waiting: Promise<string | null> | null }>()
  /** Whether the target's consoles have input gates that follow the lock, so a lock comes with a gate token. */
  gated: (target: string) => boolean = () => true

  constructor(private readonly k: Kernel) {}

  // ---------- extension points ----------

  /** Lock targets: true for one that exists, false for one not of this kind; throws for one of its kind that is missing. */
  addTarget(exists: (target: string) => boolean) { this.targets.push(exists) }
  /** Who holds a target outside boardlab, if anyone; locking waits for them as for a holder here. */
  addOccupant(occupant: (target: string) => string | null) { this.occupants.push(occupant) }
  addFollower(follower: LockFollower) { this.followers.push(follower) }
  /** Called once a lease on the target ended. */
  onEnd(listener: (target: string) => void) { this.endings.push(listener) }

  // ---------- reads ----------

  assertTarget(target: string) {
    if (!this.targets.some(exists => exists(target))) throw new BoardError('not-found', `没有这块板：${target}`)
  }

  occupant(target: string): string | null {
    for (const occupant of this.occupants) { const who = occupant(target); if (who) return who }
    return null
  }

  held(target: string): HeldLease | null {
    const row = this.k.db.prepare(`SELECT * FROM leases WHERE board=? AND status='held'`).get(target)
    if (!row) return null
    // Leases taken before boardd gated serial ports get their gate token when first needed.
    let gateToken = str(row.gate_token)
    if (!gateToken) {
      gateToken = newToken()
      this.k.db.prepare('UPDATE leases SET gate_token=? WHERE id=?').run(gateToken, row.id)
    }
    return { ...toLease(row), tokenHash: String(row.token_hash), gateToken }
  }

  /** Every held lease, oldest first. */
  holders(): Lease[] { return this.k.db.prepare(`SELECT * FROM leases WHERE status='held' ORDER BY started_at`).all().map(toLease) }

  queue(target: string): Waiter[] {
    return this.k.db.prepare('SELECT * FROM lease_waiters WHERE board=? ORDER BY queued_at, rowid').all(target).map(toWaiter)
  }

  waiters(): Waiter[] { return this.k.db.prepare('SELECT * FROM lease_waiters ORDER BY queued_at').all().map(toWaiter) }

  recent(limit: number, target?: string): Lease[] {
    return (target
      ? this.k.db.prepare('SELECT * FROM leases WHERE board=? ORDER BY started_at DESC LIMIT ?').all(target, limit)
      : this.k.db.prepare('SELECT * FROM leases ORDER BY started_at DESC LIMIT ?').all(limit)).map(toLease)
  }

  // ---------- taking and giving ----------

  /** Hand the target to a holder, no questions asked: for callers that checked inside their own transaction. */
  grant(target: string, holder: string, purpose: string): { lease: Lease, token: string, gateToken: string } {
    const token = newToken()
    const gateToken = newToken()
    const lease: Lease = { id: randomUUID(), board: target, holder, purpose, startedAt: this.k.iso(), status: 'held', endedAt: null, endReason: null }
    this.k.db.prepare('INSERT INTO leases(id, board, holder, purpose, token_hash, started_at, status, gate_token) VALUES(?,?,?,?,?,?,?,?)')
      .run(lease.id, target, holder, purpose, hash(token), lease.startedAt, 'held', gateToken)
    this.k.record(holder, target, 'lock', purpose, true)
    return { lease, token, gateToken }
  }

  /**
   * Take a target's lock. Locks have no time limit: they last until released or stolen.
   * A busy target can be queued for (`queue: 'join'`), or waited on until granted (`queue: 'wait'`, leaving the queue if
   * the caller goes away). The queue is first come, first served and survives restarts; asking again while holding the
   * lock re-issues its token.
   */
  async lock(target: string, holder: string, purpose: string, options: { queue?: 'none' | 'join' | 'wait', signal?: AbortSignal } = {}): Promise<LockResult> {
    if (!HOLDER.test(holder)) throw new BoardError('invalid', `持有人格式不对：${holder}`)
    if (!purpose.trim()) throw new BoardError('invalid', '请写明用途')
    const mode = options.queue ?? 'none'
    const result = transaction(this.k.db, (): LockResult | { waiter: string } => {
      this.assertTarget(target)
      const held = this.held(target)
      if (held?.holder === holder) {
        const token = newToken()
        this.k.db.prepare('UPDATE leases SET token_hash=? WHERE id=?').run(hash(token), held.id)
        const { tokenHash: _, gateToken, ...lease } = held
        return { lease, token, gateToken, queued: null }
      }
      const queue = this.queue(target)
      // Someone using a board in its lab directly holds it as much as a lock here does.
      const outside = held ? null : this.occupant(target)
      if (!held && !outside && !queue.length) return { ...this.grant(target, holder, purpose), queued: null }
      if (mode === 'none') {
        throw new BoardError('locked', held ? `${target} 正被 ${held.holder} 使用（${held.purpose}）${queue.length ? `，${queue.length} 人排队` : ''}`
          : outside ? `${target} 在实验室里正被 ${outside} 使用${queue.length ? `，${queue.length} 人排队` : ''}` : `${target} 有 ${queue.length} 人排队`)
      }
      const mine = queue.find(waiter => waiter.holder === holder)
      if (mine) return mode === 'join' ? { lease: null, token: null, gateToken: null, queued: { position: queue.indexOf(mine) + 1 } } : { waiter: mine.id }
      const id = randomUUID()
      this.k.db.prepare('INSERT INTO lease_waiters(id, board, holder, purpose, queued_at) VALUES(?,?,?,?,?)').run(id, target, holder, purpose, this.k.iso())
      this.k.record(holder, target, 'queue', purpose, true, `第 ${queue.length + 1} 位`)
      return mode === 'join' ? { lease: null, token: null, gateToken: null, queued: { position: queue.length + 1 } } : { waiter: id }
    })
    this.k.changed(target)
    if (!('waiter' in result)) {
      if (!this.gated(target)) result.gateToken = null
      if (result.lease) {
        // A follower that must agree (a backend leasing the board too) refuses the lock by failing.
        this.followers.forEach((follower, index) => { if (!follower.binding) void this.follow(index, target) })
        // Until the lab agrees the board shows as being locked, and nothing that needs the lab's lease starts.
        const agree = () => Promise.all(this.followers.map((follower, index) => follower.binding ? this.follow(index, target) : null))
        const refusals = this.followers.some(follower => follower.binding) && !this.k.busy.has(target)
          ? await this.k.doing([target], 'lock', '拿锁中', holder, agree) : await agree()
        const refused = refusals.find(Boolean)
        if (refused && this.held(target)?.id === result.lease.id) {
          this.end(result.lease, 'released', `实验室拒绝：${refused}`)
          this.k.record(holder, target, 'lock', purpose, false, refused)
          this.k.changed(target)
          this.stir(target)
          throw new BoardError('locked', `实验室没有让出 ${target}：${refused}`)
        }
      }
      return result
    }
    const id = result.waiter
    return new Promise<LockResult>((resolve, reject) => {
      const leave = () => {
        this.waiting.delete(id)
        this.unqueue(target, holder)
        reject(new BoardError('locked', '已停止排队'))
      }
      options.signal?.addEventListener('abort', leave, { once: true })
      this.waiting.set(id, granted => { options.signal?.removeEventListener('abort', leave); resolve(granted) })
      this.promote(target)
    })
  }

  unqueue(target: string, holder: string) {
    const removed = this.k.db.prepare('DELETE FROM lease_waiters WHERE board=? AND holder=?').run(target, holder).changes
    if (!removed) throw new BoardError('not-found', `你没有在 ${target} 排队`)
    this.k.record(holder, target, 'unqueue', null, true)
    this.k.changed(target)
  }

  /** Hand a free target to the first in its queue. */
  promote(target: string) {
    const granted = transaction(this.k.db, () => {
      if (this.held(target) || this.occupant(target)) return null
      const waiter = this.queue(target)[0]
      if (!waiter) return null
      this.k.db.prepare('DELETE FROM lease_waiters WHERE id=?').run(waiter.id)
      return { id: waiter.id, ...this.grant(target, waiter.holder, waiter.purpose) }
    })
    if (!granted) return
    this.waiting.get(granted.id)?.({ lease: granted.lease, token: granted.token, gateToken: this.gated(target) ? granted.gateToken : null, queued: null })
    this.waiting.delete(granted.id)
    this.k.emit({ type: 'lease-granted', board: target, holder: granted.lease.holder })
    this.k.changed(target)
    this.stir(target)
  }

  /** The caller's held lease. A token proves it; people may instead be matched by their own holder name. */
  authorize(target: string, caller: Caller): Lease {
    const held = this.held(target)
    if (!held) throw new BoardError('locked', `请先拿 ${target} 的锁`)
    const ok = caller.token ? hash(caller.token) === held.tokenHash : isHuman(caller.holder) && caller.holder === held.holder
    if (!ok) throw new BoardError('locked', `${target} 正被 ${held.holder} 使用（${held.purpose}）`)
    const { tokenHash: _, gateToken: __, ...lease } = held
    return lease
  }

  unlock(target: string, caller: Caller): void {
    const lease = this.authorize(target, caller)
    this.end(lease, 'released', '主动释放')
    this.k.record(lease.holder, target, 'unlock', null, true)
    this.k.changed(target)
    this.promote(target)
    this.stir(target)
  }

  /** People may take a lock from its holder with a recorded reason; the queue keeps its order. */
  steal(target: string, holder: string, reason: string, purpose = '抢锁'): LockResult {
    if (!isHuman(holder)) throw new BoardError('forbidden', '只有人可以抢锁')
    if (!reason.trim()) throw new BoardError('invalid', '抢锁必须写明原因')
    const result = transaction(this.k.db, () => {
      this.assertTarget(target)
      const held = this.held(target)
      if (held?.holder === holder) throw new BoardError('conflict', '你已经持有这把锁')
      if (held) this.end(held, 'stolen', `${holder}：${reason}`)
      this.k.db.prepare('DELETE FROM lease_waiters WHERE board=? AND holder=?').run(target, holder)
      this.k.record(holder, target, 'steal', reason, true, held ? `原持有人 ${held.holder}` : '没有持有人')
      return { previous: held?.holder ?? null, ...this.grant(target, holder, purpose) }
    })
    if (result.previous) this.k.emit({ type: 'lease-stolen', board: target, from: result.previous, by: holder, reason })
    this.k.changed(target)
    this.stir(target)
    return { lease: result.lease, token: result.token, gateToken: this.gated(target) ? result.gateToken : null, queued: null }
  }

  end(lease: Pick<Lease, 'id'>, status: Lease['status'], reason: string) {
    this.k.db.prepare('UPDATE leases SET status=?, ended_at=?, end_reason=? WHERE id=?').run(status, this.k.iso(), reason, lease.id)
    const row = this.k.db.prepare('SELECT board FROM leases WHERE id=?').get(lease.id)
    if (row) queueMicrotask(() => this.endings.forEach(listener => listener(String(row.board))))
  }

  /** A board renamed: its lock and queue go with it. */
  rename(from: string, to: string) {
    this.k.db.prepare('UPDATE leases SET board=? WHERE board=?').run(to, from)
    this.k.db.prepare('UPDATE lease_waiters SET board=? WHERE board=?').run(to, from)
  }

  /** A target gone for good: nobody waits for it any more. */
  forget(target: string) { this.k.db.prepare('DELETE FROM lease_waiters WHERE board=?').run(target) }

  // ---------- followers ----------

  /** Bring every follower in step with the target's lock and wait; returns what could not be done. */
  async settle(target: string): Promise<string[]> {
    const results = await Promise.all(this.followers.map((_, index) => this.follow(index, target)))
    return results.filter((result): result is string => !!result)
  }

  /** The same without waiting. */
  stir(target: string) { this.followers.forEach((_, index) => void this.follow(index, target)) }

  /**
   * Runs queue per follower and target and read the lock when they start, so the latest change wins; a run still waiting
   * to start already will, so asking again joins it.
   */
  private follow(index: number, target: string): Promise<string | null> {
    const key = `${index}\0${target}`
    const entry = this.runs.get(key) ?? { tail: Promise.resolve<string | null>(null), waiting: null }
    if (entry.waiting) return entry.waiting
    const run: Promise<string | null> = entry.tail.then(() => { entry.waiting = null; return this.followers[index]!.follow(target) }).catch(error => (error as Error).message)
    entry.waiting = run
    entry.tail = run
    this.runs.set(key, entry)
    void run.then(() => { if (this.runs.get(key) === entry && entry.tail === run) this.runs.delete(key) })
    return run
  }
}
