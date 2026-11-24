/**
 * Board consoles, through each board's backend. Watching is shared: everyone watching one chip shares one session,
 * which keeps recent output for late arrivals and closes a while after the last viewer leaves. Typing goes through one
 * session per board, chip and lock, kept open while typing goes on, so keystrokes are not each a new connection.
 */
import type { SendResult } from '../shared/types.ts'
import type { LogQuery, LogRange } from './backend.ts'
import type { ConsoleSession } from './console.ts'
import { BoardError } from './errors.ts'
import type { BoardLab } from './lab.ts'
import type { Caller } from './locks.ts'
import { BOOT_MARKS, badMark, bootMarks, findBootLines, type BootMark } from './boot-marks.ts'
import { LineRing } from './ring.ts'
import { isHuman, stripAnsi } from './text.ts'

export interface ConsoleTiming {
  /** A watched console stays open this long after its last viewer leaves, so switching back to it is instant. */
  watchIdleMs: number
  /** A console nobody typed into for this long gives its session back. */
  typingIdleMs: number
  /** How much recent output a watched console keeps for viewers who arrive later. */
  watchLines: number
  /**
   * A console whose backend failed to open (or closed again at once) is not opened again for this long, doubling with
   * each failure up to `openRetryMaxMs`: viewers retrying meanwhile get the last error at once, rather than each retry
   * starting another backend connection.
   */
  openRetryMs: number
  openRetryMaxMs: number
}
export const CONSOLE_TIMING: ConsoleTiming = { watchIdleMs: 30_000, typingIdleMs: 60_000, watchLines: 2_000, openRetryMs: 1_000, openRetryMaxMs: 30_000 }
/** A backend session that ends sooner than this after it opened counts as a failed open. */
const SHORT_LIVED_MS = 5_000

/** The last time a console's backend failed to open: what it said, and when it may be tried again. */
interface Failure { error: string, code: BoardError['code'], count: number, until: number }

interface Watch {
  key: string
  session: Promise<ConsoleSession>
  /** Its recent lines, numbered from the first this watch saw, so a number stays a line's own. */
  lines: LineRing
  /** This watch's own name in its lines' positions: a position from a watch gone since names no line here. */
  epoch: string
  partial: string
  outputs: Set<(data: Buffer) => void>
  closes: Set<(reason: string) => void>
  viewers: number
  idle: ReturnType<typeof setTimeout> | null
  lastSeen: number
}

export class Consoles {
  private readonly watches = new Map<string, Watch>()
  private epochs = 0
  private readonly failures = new Map<string, Failure>()
  private readonly shutdowns = new Set<(reason: string) => void>()
  private readonly typing = new Map<string, { session: Promise<ConsoleSession>, timer: ReturnType<typeof setTimeout> | null }>()
  /** People who typed through a watched console, so their input is recorded once per console. */
  private readonly humans = new Set<string>()

  private readonly timing: ConsoleTiming

  constructor(private readonly lab: BoardLab, timing: Partial<ConsoleTiming> = {}) {
    this.timing = { ...CONSOLE_TIMING, ...timing }
    lab.locks.onEnd(board => this.closeTyping(board))
  }

  /** Streams that want to say boardd is stopping before it closes them (see `shutdown`). */
  onShutdown(listener: (reason: string) => void) { this.shutdowns.add(listener) }
  offShutdown(listener: (reason: string) => void) { this.shutdowns.delete(listener) }
  /** boardd is stopping: tell every console stream why, before its connection goes. */
  shutdown(reason: string) {
    for (const listener of [...this.shutdowns]) { this.shutdowns.delete(listener); try { listener(reason) } catch { /* a stream already gone */ } }
  }

  /** The backend failed to open the console (or its session ended at once): hold off the next open for a while. */
  private failed(key: string, error: unknown) {
    const count = (this.failures.get(key)?.count ?? 0) + 1
    const wait = Math.min(this.timing.openRetryMs * 2 ** (count - 1), this.timing.openRetryMaxMs)
    const message = error instanceof Error ? error.message : String(error)
    this.failures.set(key, { error: message, code: error instanceof BoardError ? error.code : 'hardware', count, until: this.lab.kernel.now() + wait })
  }

  /**
   * Watch a chip's console. Close the returned session to leave; input never goes through it. A backend that lists its
   * boards may report a port down a minute late, so opening asks the backend itself.
   */
  async open(board: string, die?: string): Promise<ConsoleSession> {
    const chip = this.lab.boards.chip(board, die)
    const key = `${board}\0${chip.die}`
    let watch = this.watches.get(key)
    if (!watch) {
      // A console that just failed is not opened again yet: every viewer retrying gets the backend's last word, as it
      // said it. The wait is not in the message (`reap` reports it): a viewer compares reasons to tell a new one.
      const failure = this.failures.get(key)
      const now = this.lab.kernel.now()
      if (failure && now < failure.until) throw new BoardError(failure.code, failure.error)
      const route = this.lab.backends.route(board, chip.die)
      const opening = route.backend.serial.open(route.config, route.target, { history: true })
      const created: Watch = { key, session: opening, lines: new LineRing(this.timing.watchLines), epoch: (++this.epochs).toString(36), partial: '', outputs: new Set(), closes: new Set(), viewers: 0, idle: null, lastSeen: now }
      watch = created
      this.watches.set(key, created)
      opening.then(session => {
        const opened = this.lab.kernel.now()
        created.lines = new LineRing(this.timing.watchLines, session.history)
        session.onOutput(data => {
          const text = created.partial + data.toString('utf8')
          const parts = text.split('\n')
          created.partial = parts.pop() ?? ''
          for (const line of parts) created.lines.push(line.replace(/\r$/, ''))
          created.outputs.forEach(fn => fn(data))
        })
        session.onClose(reason => {
          // Gone as soon as it came (a pipe that dies after its handshake): a failure like one that never opened.
          if (this.lab.kernel.now() - opened < SHORT_LIVED_MS) this.failed(key, reason || '串口刚打开就断了')
          this.drop(created)
          created.closes.forEach(fn => fn(reason))
        })
      }, error => { this.failed(key, error); this.drop(created) })
      void opening.then(() => {
        // Held a while: the console works again, and a later failure starts its backoff over.
        const timer = setTimeout(() => { if (this.watches.get(key) === created) this.failures.delete(key) }, SHORT_LIVED_MS)
        timer.unref?.()
      }, () => {})
    }
    const shared = watch
    const session = await shared.session
    shared.viewers++
    shared.lastSeen = this.lab.kernel.now()
    if (shared.idle) { clearTimeout(shared.idle); shared.idle = null }
    const outputs = new Set<(data: Buffer) => void>(), closes = new Set<(reason: string) => void>()
    const relay = (data: Buffer) => outputs.forEach(fn => fn(data))
    const ended = (reason: string) => closes.forEach(fn => fn(reason))
    shared.outputs.add(relay)
    shared.closes.add(ended)
    let left = false
    return {
      hello: session.hello,
      history: [...shared.lines.slice(), ...(shared.partial ? [shared.partial] : [])],
      send: () => { throw new BoardError('invalid', '看串口的连接不能输入；输入要拿锁走 /api/console/input') },
      onOutput: fn => { outputs.add(fn); return () => outputs.delete(fn) },
      onClose: fn => { closes.add(fn) },
      close: () => {
        if (left) return
        left = true
        shared.outputs.delete(relay)
        shared.closes.delete(ended)
        shared.viewers--
        shared.lastSeen = this.lab.kernel.now()
        if (shared.viewers <= 0 && this.watches.get(key) === shared) shared.idle = setTimeout(() => this.drop(shared), this.timing.watchIdleMs)
        shared.idle?.unref?.()
      },
    }
  }

  private drop(watch: Watch) {
    if (watch.idle) { clearTimeout(watch.idle); watch.idle = null }
    if (this.watches.get(watch.key) !== watch) return
    this.watches.delete(watch.key)
    void watch.session.then(session => session.close(), () => {})
  }

  /**
   * Close console sessions nobody uses any more: watches whose viewers left without saying so. boardd runs it on a timer,
   * so a viewer that vanished never leaves a connection behind.
   */
  reap() {
    const now = this.lab.kernel.now()
    for (const watch of [...this.watches.values()]) {
      if (watch.viewers <= 0 && now - watch.lastSeen > this.timing.watchIdleMs) this.drop(watch)
    }
    for (const [key, failure] of this.failures) if (now >= failure.until + this.timing.openRetryMaxMs) this.failures.delete(key)
    return {
      watching: [...this.watches.values()].map(watch => ({ console: watch.key.replace('\0', '.'), viewers: watch.viewers })), typing: this.typing.size,
      // Consoles whose backend failed to open lately, with what it said.
      failing: [...this.failures].map(([key, failure]) => ({ console: key.replace('\0', '.'), error: failure.error, failures: failure.count, retryInMs: Math.max(0, failure.until - now) })),
    }
  }

  /**
   * A chip's log over a time range, searched, for export and search: from the backend when it keeps logs it can read
   * back, else from what this console has buffered.
   */
  async logs(board: string, die: string | undefined, query: LogQuery): Promise<LogRange & { source: 'backend' | 'buffer' }> {
    const chip = this.lab.boards.chip(board, die)
    const route = this.lab.backends.route(board, chip.die)
    const limit = Math.max(1, Math.min(query.limit ?? 20000, 200000))
    if (query.regex && query.grep) { try { new RegExp(query.grep) } catch (error) { throw new BoardError('invalid', `不是合法的正则：${(error as Error).message}`) } }
    const window = { before: span(query.before), after: span(query.after) }
    if (query.marks) for (const mark of query.marks) { const bad = badMark(mark); if (bad) throw new BoardError('invalid', bad) }
    if (query.fromLine !== undefined && !(Number.isInteger(query.fromLine) && query.fromLine >= 0)) throw new BoardError('invalid', `fromLine 要写行号：${query.fromLine}`)
    const maxHits = Math.max(1, Math.min(query.maxHits ?? MAX_HITS, MAX_HITS))
    if (query.at != null && !/^[\x21-\x7e]{1,80}$/.test(query.at)) throw new BoardError('invalid', `at 不对：${query.at}`)
    const asked: LogQuery = {
      ...query, limit, ...(query.at != null ? window : {}), ...(query.hits ? { maxHits } : {}),
      ...(query.marks ? { marks: query.marks.map(({ id, pattern, flags }) => ({ id, pattern, flags: flags ?? '' }) as BootMark), maxMarks: Math.max(1, Math.min(query.maxMarks ?? 100_000, 100_000)) } : {}),
    }
    if (route.backend.serial.logs) {
      try { return { ...(await route.backend.serial.logs(route.config, route.target, asked)), source: 'backend' } }
      catch (error) { throw new BoardError('hardware', (error as Error).message) }
    }
    // No log of its own: the console's buffer, numbered from the first line this watch saw.
    const session = await this.open(board, die)
    const watch = this.watches.get(`${board}\0${chip.die}`)!
    // Read in place: a line is taken (and its colours stripped) only when the answer needs it.
    const held = watch.lines, partial = watch.partial
    const lines: LogLines = { length: held.length + (partial ? 1 : 0), at: index => stripAnsi(index < held.length ? held.get(held.base + index)! : partial) }
    const read = readLog(lines, held.base, watch.epoch, asked)
    session.close()
    return { ...read, source: 'buffer' }
  }

  /** The lines that open a boot on this chip's console: the core's, and those its backend adds. */
  async bootMarks(board: string, die?: string): Promise<BootMark[]> {
    const chip = this.lab.boards.chip(board, die)
    const route = this.lab.backends.route(board, chip.die)
    let own: BootMark[] = []
    try { own = (await route.backend.serial.bootMarks?.(route.config, route.target)) ?? [] } catch { own = [] }
    // A backend's mark that is not one is left out, not passed on to every page.
    return bootMarks(BOOT_MARKS, own.filter(mark => !badMark(mark)))
  }

  async log(board: string, die?: string, lines = 200): Promise<string[]> {
    const session = await this.open(board, die)
    session.close()
    return session.history.slice(-lines)
  }

  /**
   * Type into a chip's console under the board's lock, as a terminal does: the bytes go out as they are. People type
   * without the lock (`human`), so a person can always step in next to an agent; agents need it.
   */
  async input(board: string, caller: Caller, input: { die?: string, data: string, human?: boolean }): Promise<void> {
    const asHuman = !!input.human && isHuman(caller.holder)
    const lease = asHuman ? { id: `human:${caller.holder}`, holder: caller.holder } : this.lab.locks.authorize(board, caller)
    if (!input.data) return
    if (input.data.length > 64 * 1024) throw new BoardError('invalid', '一次输入太多')
    const chip = this.lab.boards.chip(board, input.die)
    // A person types where they watch: the console they have open already carries the bytes, with no new session to
    // open first (for a lab, a new connection to its host). Agents keep a session of their own under the lock.
    // On a port whose input gate follows the lock, the watched session holds the gate token of when it opened, so it
    // types through its own session there as before.
    const gated = !!this.lab.backends.route(board, chip.die).backend.serial.gated
    const watched = asHuman && !gated ? this.watches.get(`${board}\0${chip.die}`) : undefined
    if (watched && watched.viewers > 0) {
      let session: ConsoleSession | null = null
      try { session = await watched.session } catch {}
      if (session) {
        if (!this.humans.has(`${board}\0${chip.die}\0${caller.holder}`)) {
          this.humans.add(`${board}\0${chip.die}\0${caller.holder}`)
          const held = this.lab.locks.held(board)
          this.lab.kernel.record(lease.holder, board, 'console-input', `${chip.die}（人，不查锁${held && held.holder !== caller.holder ? `；锁在 ${held.holder} 手里` : ''}）`, true)
        }
        session.send(Buffer.from(input.data, 'utf8'))
        return
      }
    }
    const key = `${board}\0${chip.die}\0${lease.id}`
    let entry = this.typing.get(key)
    if (!entry) {
      const route = this.lab.backends.route(board, chip.die)
      const opening = route.backend.serial.open(route.config, route.target, { history: false })
      entry = { session: opening, timer: null }
      this.typing.set(key, entry)
      const forget = () => { if (this.typing.get(key) === entry) { this.typing.delete(key); if (entry!.timer) clearTimeout(entry!.timer) } }
      opening.then(session => session.onClose(forget), forget)
      const held = this.lab.locks.held(board)
      this.lab.kernel.record(lease.holder, board, 'console-input', asHuman ? `${chip.die}（人，不查锁${held && held.holder !== caller.holder ? `；锁在 ${held.holder} 手里` : ''}）` : chip.die, true)
    }
    let session: ConsoleSession
    try { session = await entry.session }
    catch (error) { throw error instanceof BoardError ? error : new BoardError('hardware', `打不开 ${board}.${chip.die} 的串口：${(error as Error).message}`) }
    session.send(Buffer.from(input.data, 'utf8'))
    if (entry.timer) clearTimeout(entry.timer)
    const current = entry
    current.timer = setTimeout(() => { if (this.typing.get(key) === current) this.typing.delete(key); session.close() }, this.timing.typingIdleMs)
    current.timer.unref?.()
  }

  /** Close the typing sessions of locks that ended; a person's does not depend on the lock and ends when they stop. */
  private closeTyping(board: string) {
    const held = this.lab.locks.held(board)?.id
    for (const [key, entry] of this.typing) {
      const [name, , lease] = key.split('\0')
      if (name !== board || lease === held || lease?.startsWith('human:')) continue
      this.typing.delete(key)
      if (entry.timer) clearTimeout(entry.timer)
      void entry.session.then(session => session.close(), () => {})
    }
  }

  /** Send text to a chip's console under the board's lock and optionally wait for a pattern. */
  async send(board: string, caller: Caller, input: { die?: string, text: string, newline?: boolean, wait?: string, timeoutMs?: number }): Promise<SendResult> {
    const lease = this.lab.locks.authorize(board, caller)
    const chip = this.lab.boards.chip(board, input.die)
    let pattern: RegExp | null = null
    if (input.wait) {
      try { pattern = new RegExp(input.wait) } catch { throw new BoardError('invalid', `等待模式不是合法正则：${input.wait}`) }
    }
    const route = this.lab.backends.route(board, chip.die)
    const session = await route.backend.serial.open(route.config, route.target, { history: false })
    let output = ''
    try {
      const matched = await new Promise<boolean>(resolve => {
        const timeoutMs = Math.min(input.timeoutMs ?? (pattern ? 10_000 : 1_000), 300_000)
        const timer = setTimeout(() => resolve(false), timeoutMs)
        session.onOutput(data => {
          output += data.toString('utf8')
          if (pattern?.test(stripAnsi(output))) { clearTimeout(timer); resolve(true) }
        })
        session.onClose(() => { clearTimeout(timer); resolve(false) })
        session.send(input.text + (input.newline === false ? '' : '\n'))
      })
      this.lab.kernel.record(lease.holder, board, 'send', `${chip.die}: ${input.text.slice(0, 120)}`, true, pattern ? (matched ? '匹配' : '超时') : null)
      return { output: stripAnsi(output), matched }
    } finally { session.close() }
  }
}

const STAMP = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]/
/** At most this many lines on either side of a window, and this many match numbers from one search. */
export const MAX_SPAN = 5000
export const MAX_HITS = 1_000_000
const span = (value: number | undefined) => Math.max(0, Math.min(Math.floor(Number(value) || 0), MAX_SPAN))

/**
 * Read `lines` (numbered from `base`, named in positions by `epoch`) as a query asks: a window around `at`, or a search
 * (see `filterLog`), each line with its number and position.
 */
/** Lines read by index without copying them: an array, or a console's ring. */
export interface LogLines { length: number, at(index: number): string }

export function readLog(lines: LogLines | string[], base: number, epoch: string, query: LogQuery): LogRange {
  if (Array.isArray(lines)) { const list = lines; lines = { length: list.length, at: index => list[index]! } }
  const log = lines
  const total = lines.length
  const name = (index: number) => `b${epoch}:${base + index}`
  if (query.at == null) {
    // From a line on: the lines before it are not searched (a page following the log asks only for what is new).
    const skip = Math.max(0, Math.min(total, (query.fromLine ?? base) - base))
    const rest: LogLines = skip ? { length: total - skip, at: index => log.at(skip + index) } : log
    const boots = query.marks ? findBootLines(rest, base + skip, query.marks, query.maxMarks) : null
    if (boots && !query.grep) return { lines: [], matched: 0, truncated: false, total, base, positions: [], numbers: [], ...boots }
    const { indexes, ...found } = filterLog(rest, query)
    if (found.hits) found.hits = found.hits.map(index => base + skip + index)
    return { ...found, total, base, positions: indexes.map(index => name(skip + index)), numbers: indexes.map(index => base + skip + index), ...boots }
  }
  // Where `at` is: a number, a position of this buffer, or either end. A line gone (or a position from another
  // buffer) is the nearest one kept.
  let index: number | null, snapped = false
  const at = query.at
  const own = new RegExp(`^b${epoch}:(\\d+)$`).exec(at)
  const numbered = /^line:(\d+)$/.exec(at) ?? own
  if (at === 'start') index = null
  else if (at === 'end') index = null
  else if (numbered) index = Number(numbered[1]) - base
  else { index = total - 1; snapped = true }
  if (index !== null && (index < 0 || index >= total)) { snapped = true; index = Math.max(0, Math.min(index, total - 1)) }
  const before = query.before ?? 0, after = query.after ?? 0
  let from: number, to: number
  if (at === 'start') { from = 0; to = Math.min(total, after) }
  else if (at === 'end') { from = Math.max(0, total - before); to = total }
  else if (total === 0) { from = 0; to = 0 }
  else { from = Math.max(0, index! - before); to = Math.min(total, index! + after + 1) }
  const indexes = Array.from({ length: to - from }, (_, i) => from + i)
  return {
    lines: Array.from({ length: to - from }, (_, i) => log.at(from + i)), matched: to - from, truncated: false, total, base,
    positions: indexes.map(name), numbers: indexes.map(i => base + i),
    at: index === null || total === 0 ? null : name(index), moreBefore: from > 0, moreAfter: to < total, snapped,
  }
}

/**
 * Lines stamped within the range (unstamped ones go with the line before), matching the search, capped; with `hits`,
 * the indexes of every match (at most `maxHits`) instead of the lines. `indexes` says where each line kept is in `lines`.
 */
export function filterLog(lines: LogLines | string[], query: LogQuery): LogRange & { indexes: number[] } {
  if (Array.isArray(lines)) { const list = lines; lines = { length: list.length, at: index => list[index]! } }
  const log = lines
  const lo = (query.since ?? '').slice(0, 19), hi = (query.until ?? '9999').slice(0, 19)
  const needle = query.grep && !query.regex ? query.grep.toLowerCase() : null
  const rx = query.grep && query.regex ? new RegExp(query.grep) : null
  const limit = query.limit ?? 20000, maxHits = query.maxHits ?? MAX_HITS
  let inside = !lo
  const found: number[] = []
  let matched = 0
  for (let index = 0; index < lines.length; index++) {
    const line = log.at(index)
    const stamp = STAMP.exec(line)?.[1]
    if (stamp) inside = lo <= stamp && stamp <= hi
    if (!inside || (needle && !line.toLowerCase().includes(needle)) || (rx && !rx.test(line))) continue
    matched++
    if (query.hits ? found.length < maxHits : true) found.push(index)
  }
  if (query.hits) return { lines: [], matched, truncated: false, hits: found, hitsTruncated: matched > found.length, indexes: [] }
  const indexes = found.length <= limit ? found : query.first ? found.slice(0, limit) : found.slice(-limit)
  return { lines: indexes.map(index => log.at(index)), matched, truncated: matched > indexes.length, indexes }
}
