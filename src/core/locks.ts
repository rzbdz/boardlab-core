/**
 * Board locks. People and agents share one set: a lock is needed to reset, boot or type on a board, it lasts until it is
 * released or stolen, and a busy board can be queued for. What lives outside the lock table follows each lock through
 * followers (a serial port's input gate, a backend's own lease), registered by whoever keeps it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Lease, LockResult, Waiter, YieldRequest } from '../shared/types.ts'
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

/**
 * A person stepping in beside a holder for one operation: not a lock of their own, and the holder's lock is not taken
 * from them. It ends when the operation it was given for does (`finishOperation`).
 */
export const TAKEOVER = '接管操作'
/** Who a takeover is recorded as, in the board's history. */
export const TAKEOVER_BY = 'boardd'

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
  /** Each board a person is stepping in on (see TAKEOVER): who, and the token of the one operation given to them. */
  private readonly takes = new Map<string, { holder: string, token: string }>()
  /** Whether the target's consoles have input gates that follow the lock, so a lock comes with a gate token. */
  gated: (target: string) => boolean = () => true

  /** How long an agent asking a person to let go waits for the answer. */
  yieldTimeoutMs = 60_000
  private readonly yields = new Map<string, { request: YieldRequest, answer: (what: 'yield' | 'deny' | 'timeout') => void }>()

  constructor(private readonly k: Kernel) {}

  /** Agents waiting for a person to let go of a board: the ones `caller` can answer, or all when `caller` is null. */
  yieldsList(caller: string | null = null): YieldRequest[] {
    return [...this.yields.values()].map(item => item.request)
      .filter(request => caller === null || request.owner === caller)
  }

  /**
   * The holder answers an agent's request: yields the board now, or keeps it (the agent then fails after its wait).
   * Answering the same request twice is answering once: the second answer says so instead of failing.
   */
  answerYield(target: string, caller: string, action: 'yield' | 'deny'): string {
    const pending = this.yields.get(target)
    if (!pending) {
      // The request is gone: the holder answered it in another window, or the agent's wait ran out.
      const held = this.held(target)
      if (!held || held.holder === caller) return `已经回答过了：${target}`
      throw new BoardError('not-found', `${target} 没有人在等让出`)
    }
    if (pending.request.owner !== caller) throw new BoardError('forbidden', `只有拿着 ${target} 的人能回答`)
    this.yields.delete(target)
    pending.answer(action)
    return action === 'yield' ? `让出了 ${target}` : `继续用 ${target}`
  }

  /** Ask the person holding a board to let an agent have it; true if they did. */
  private async askYield(target: string, holder: string, purpose: string, held: Lease): Promise<boolean> {
    // A board a person is stepping in on is busy with that one operation: an agent waits for it to end like any run.
    if (this.takes.has(target)) throw new BoardError('locked', `${target} 正被人手动操作：这一步调不通，等它做完再试（板子的锁没变）`)
    // Nothing keeps a person from taking the board by force under the wait, and the wait has nothing to go on then.
    if (this.yields.has(target)) throw new BoardError('conflict', `${target} 已经有一个 AI 在等让出`)
    const request: YieldRequest = {
      id: randomUUID(), board: target, holder, purpose, owner: held.holder,
      at: this.k.iso(), until: this.k.iso(this.yieldTimeoutMs),
    }
    const answer = new Promise<'yield' | 'deny' | 'timeout'>(resolve => {
      this.yields.set(target, { request, answer: resolve })
      this.k.record(holder, target, 'yield-request', purpose, false, `等 ${held.holder} 让出`)
      this.k.changed(target)
      setTimeout(() => {
        // Only this request's own wait ends here: a later one on the same board keeps waiting.
        if (this.yields.get(target)?.request !== request) return
        this.yields.delete(target)
        this.k.record(holder, target, 'yield-request', purpose, false, '等了 60 秒没有回应')
        this.k.changed(target)
        resolve('timeout')
      }, this.yieldTimeoutMs).unref?.()
    })
    const what = await answer
    if (what === 'yield') {
      this.end(held, 'released', `${held.holder} 让给了 ${holder}`)
      this.k.record(held.holder, target, 'yield', `${holder}（${purpose}）`, true)
      this.k.changed(target)
      return true
    }
    return false
  }

  // ---------- extension points ----------

  /** Lock targets: true for one that exists, false for one not of this kind; throws for one of its kind that is missing. */
  addTarget(exists: (target: string) => boolean) { this.targets.push(exists); this.k.track(() => this.removeTarget(exists)) }
  removeTarget(exists: (target: string) => boolean) { this.drop(this.targets, exists) }
  /** Who holds a target outside boardlab, if anyone; locking waits for them as for a holder here. */
  addOccupant(occupant: (target: string) => string | null) { this.occupants.push(occupant); this.k.track(() => this.removeOccupant(occupant)) }
  removeOccupant(occupant: (target: string) => string | null) { this.drop(this.occupants, occupant) }
  addFollower(follower: LockFollower) { this.followers.push(follower); this.k.track(() => this.removeFollower(follower)) }
  removeFollower(follower: LockFollower) { this.drop(this.followers, follower) }
  private drop<T>(list: T[], item: T) { const at = list.indexOf(item); if (at >= 0) list.splice(at, 1) }
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
    // An agent asking for a board a person is using asks the person first (the page shows it), and waits for the answer.
    if (mode === 'none' && !isHuman(holder)) {
      const heldNow = this.held(target)
      if (heldNow && heldNow.holder !== holder && isHuman(heldNow.holder)) {
        const yielded = await this.askYield(target, holder, purpose, heldNow)
        if (!yielded) {
          const why = this.k.occupied(target) ? '正忙' : '人还在用'
          throw new BoardError('locked', `${target} 正被 ${heldNow.holder} 使用（${heldNow.purpose}）：${why}，没有让出。可以排队等它：${this.queueHint(target, purpose)}`)
        }
      }
    }
    let result: LockResult | { waiter: string }
    try { result = transaction(this.k.db, (): LockResult | { waiter: string } => {
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
        const behind = queue.length ? `，${queue.length} 人排队` : ''
        // The refusal says how to queue for it: an agent reads the answer and knows its next move.
        throw new BoardError('locked', held ? `${target} 正被 ${held.holder} 使用（${held.purpose}）${behind}。可以排队等它：${this.queueHint(target, purpose)}`
          : outside ? `${target} 在实验室里正被 ${outside} 使用${behind}。可以排队等它：${this.queueHint(target, purpose)}`
            : `${target} 有${behind.replace(/^，/, ' ')}。可以排队等它：${this.queueHint(target, purpose)}`)
      }
      const mine = queue.find(waiter => waiter.holder === holder)
      if (mine) return mode === 'join' ? { lease: null, token: null, gateToken: null, queued: { position: queue.indexOf(mine) + 1 } } : { waiter: mine.id }
      const id = randomUUID()
      this.k.db.prepare('INSERT INTO lease_waiters(id, board, holder, purpose, queued_at) VALUES(?,?,?,?,?)').run(id, target, holder, purpose, this.k.iso())
      this.k.record(holder, target, 'queue', purpose, true, `第 ${queue.length + 1} 位`)
      return mode === 'join' ? { lease: null, token: null, gateToken: null, queued: { position: queue.length + 1 } } : { waiter: id }
    }) }
    catch (error) {
      // A lock that was refused is recorded too: who asked, for what, and why not (the history shows it, ok=false).
      if (error instanceof BoardError && error.code === 'locked') this.k.record(holder, target, 'lock', purpose, false, error.message)
      throw error
    }
    this.k.changed(target)
    if (!('waiter' in result)) {
      if (!this.gated(target)) result.gateToken = null
      if (result.lease) {
        // A follower that must agree (a backend leasing the board too) refuses the lock by failing.
        this.followers.forEach((follower, index) => { if (!follower.binding) void this.follow(index, target) })
        // Until the lab agrees the board shows as being locked, and nothing that needs the lab's lease starts.
        const agree = () => Promise.all(this.followers.map((follower, index) => follower.binding ? this.follow(index, target) : null))
        const refusals = this.followers.some(follower => follower.binding) && !this.k.occupied(target)
          ? await this.k.doing([target], 'lock', '拿锁中', holder, agree, { lease: result.lease.id }) : await agree()
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

  /**
   * How a caller that was refused may queue for the target, as the refusal tells it: `lock` with a queue, joining (it
   * goes on with its own work) or waiting (it holds until the board is handed to it).
   */
  private queueHint(target: string, purpose: string): string { return `boardlab lock ${target} --for "${purpose}" --wait（API 里 queue: "wait"；只排队用 join）` }

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

  /** The caller's held lease. A token proves it; people may instead be matched by their own holder name. A person
   *  stepping in on the board (TAKEOVER) acts on the holder's lease for one operation with the token `takeOver` gave them;
   *  the holder's own token is not accepted again until that operation ends. */
  authorize(target: string, caller: Caller): Lease {
    const held = this.held(target)
    if (!held) throw new BoardError('locked', `请先拿 ${target} 的锁`)
    const stepping = this.steppingIn(target, caller)
    const holder = caller.token ? hash(caller.token) === held.tokenHash : isHuman(caller.holder) && caller.holder === held.holder
    // One person drives the board: while someone steps in, the holder's own operations wait for it to end. Their lock is
    // untouched, and works again the moment the step-in is over.
    const take = this.takes.get(target)
    if (take && !stepping) throw new BoardError('locked', `${target} 正被 ${take.holder} 手动操作：等这一步结束`)
    if (!stepping && !holder) throw new BoardError('locked', `${target} 正被 ${held.holder} 使用（${held.purpose}）`)
    const { tokenHash: _, gateToken: __, ...lease } = held
    // Read as the stepping-in person's own for the operation: their history, their run, and their end of it.
    return stepping ? { ...lease, holder: this.takes.get(target)!.holder } : lease
  }

  unlock(target: string, caller: Caller): void {
    this.assertTarget(target)
    const lease = this.authorize(target, caller)
    // Letting go is the holder's own: a person stepping in ends their step-in, never the lock under it.
    if (this.steppingIn(target, caller)) { this.finishOperation(target); return }
    this.end(lease, 'released', '主动释放')
    this.k.record(lease.holder, target, 'unlock', null, true)
    this.k.changed(target)
    this.promote(target)
    this.stir(target)
  }

  /** People may take a lock from its holder with a recorded reason; the queue keeps its order. */
  steal(target: string, holder: string, reason: string): LockResult {
    if (!isHuman(holder)) throw new BoardError('forbidden', '只有人可以抢锁')
    if (!reason.trim()) throw new BoardError('invalid', '抢锁必须写明原因')
    const result = transaction(this.k.db, () => {
      this.assertTarget(target)
      const held = this.held(target)
      if (held?.holder === holder) throw new BoardError('conflict', '你已经持有这把锁')
      // Taking the lock takes it from everyone on it, a person stepping in included.
      this.takes.delete(target)
      if (held) this.end(held, 'stolen', `${holder}：${reason}`)
      this.k.db.prepare('DELETE FROM lease_waiters WHERE board=? AND holder=?').run(target, holder)
      this.k.record(holder, target, 'steal', reason, true, held ? `原持有人 ${held.holder}` : '没有持有人')
      return { previous: held?.holder ?? null, ...this.grant(target, holder, `抢锁：${reason.trim()}`) }
    })
    if (result.previous) this.k.emit({ type: 'lease-stolen', board: target, from: result.previous, by: holder, reason })
    this.k.changed(target)
    this.stir(target)
    return { lease: result.lease, token: result.token, gateToken: this.gated(target) ? result.gateToken : null, queued: null }
  }

  /**
   * A person stepping in on the board for one operation, beside whoever holds it: the holder's lock stays theirs and
   * nothing is taken from them — it is not a lock of one's own, which is what `steal` is for. What the caller gets is a
   * token good for one operation: it is used to act on the board now, and ends when that operation does
   * (`finishOperation`). Whatever boardd runs on the board stops first, and an agent's runs are refused while it lasts.
   */
  async takeOver(target: string, holder: string): Promise<{ lease: Lease, token: string }> {
    if (!isHuman(holder)) throw new BoardError('forbidden', '只有人可以接管操作')
    this.assertTarget(target)
    const held = this.held(target)
    // A board nobody holds is not taken over: the page's button is for a board an agent is using.
    if (!held) throw new BoardError('conflict', `${target} 没有在被使用：直接拿锁就好`)
    if (held.holder === holder) throw new BoardError('conflict', '锁已经是你自己的了，直接操作就好')
    if (this.takes.has(target)) throw new BoardError('conflict', `${target} 已经有人在接管操作了`)
    // The operation boardd is doing stops before the person touches the board: they cannot both drive it.
    await this.k.stopForTakeover(target, holder)
    // Looked at again: the board may have been let go of, or taken by another person, while that ran.
    const now = this.held(target)
    if (!now) throw new BoardError('conflict', `${target} 的锁在接管前已经放开了：直接拿锁就好`)
    if (now.holder === holder) throw new BoardError('conflict', '锁已经是你自己的了，直接操作就好')
    const token = newToken()
    const lease: Lease = { id: randomUUID(), board: target, holder, purpose: TAKEOVER, startedAt: this.k.iso(), status: 'held', endedAt: null, endReason: null }
    this.takes.set(target, { holder, token })
    this.k.record(holder, target, 'take-over', now.purpose, true, `接管 ${now.holder} 的一次操作`)
    this.k.changed(target)
    return { lease: { ...lease, holder: now.holder }, token }
  }

  /** Whether a person is stepping in on the target for one operation, and who (`null` when nobody is). */
  stepping(target: string): string | null { return this.takes.get(target)?.holder ?? null }

  /** Whether `caller` is the person stepping in (a token, when given, must be the one `takeOver` gave them). */
  private steppingIn(target: string, caller: Caller): boolean {
    const take = this.takes.get(target)
    if (!take || take.holder !== caller.holder) return false
    return !caller.token || hash(caller.token) === hash(take.token)
  }

  end(lease: Pick<Lease, 'id'>, status: Lease['status'], reason: string) {
    this.k.db.prepare('UPDATE leases SET status=?, ended_at=?, end_reason=? WHERE id=?').run(status, this.k.iso(), reason, lease.id)
    // What the holder was doing on the board stops holding it up for whoever comes next.
    this.k.leaseEnded(lease.id)
    const row = this.k.db.prepare('SELECT board FROM leases WHERE id=?').get(lease.id)
    if (row) queueMicrotask(() => this.endings.forEach(listener => listener(String(row.board))))
  }

  /**
   * One operation a person stepped in on has ended: their token stops working, the board goes back to its holder
   * untouched, and whatever the backend kept of a lease for the step-in is given back. Every way an operation can end
   * calls it (a reset and a download mode, a relay or a button, a run's end).
   */
  finishOperation(target: string): void {
    const take = this.takes.get(target)
    if (take) {
      this.takes.delete(target)
      this.k.record(TAKEOVER_BY, target, 'take-over-end', null, true, '接管的一次操作做完了')
      this.k.changed(target)
    }
    // A backend's lease of its own is no holder's: give it back, the next lock takes a fresh one.
    setTimeout(() => this.stir(target), 0)
  }

  /** Every board a person is still stepping in on: one operation each, and a restart is no place for one to outlive. */
  releasedTakeovers(): number {
    const targets = [...this.takes.keys()]
    for (const target of targets) {
      this.takes.delete(target)
      this.k.record(TAKEOVER_BY, target, 'take-over-end', null, true, 'boardd 重新开始，接管的一次操作作废')
      this.k.changed(target)
    }
    return targets.length
  }

  /** A board renamed: its lock, queue and any request to let go of it go with it. */
  rename(from: string, to: string) {
    this.k.db.prepare('UPDATE leases SET board=? WHERE board=?').run(to, from)
    this.k.db.prepare('UPDATE lease_waiters SET board=? WHERE board=?').run(to, from)
    const pending = this.yields.get(from)
    if (pending) { this.yields.delete(from); pending.request.board = to; this.yields.set(to, pending) }
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
