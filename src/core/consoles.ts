/**
 * Board consoles, through each board's backend. Watching is shared: everyone watching one chip shares one session,
 * which keeps recent output for late arrivals and closes a while after the last viewer leaves. Typing goes through one
 * session per board, chip and lock, kept open while typing goes on, so keystrokes are not each a new connection.
 */
import type { SendResult } from '../shared/types.ts'
import type { ConsoleSession } from './console.ts'
import { BoardError } from './errors.ts'
import type { BoardLab } from './lab.ts'
import type { Caller } from './locks.ts'
import { isHuman, stripAnsi } from './text.ts'

export interface ConsoleTiming {
  /** A watched console stays open this long after its last viewer leaves, so switching back to it is instant. */
  watchIdleMs: number
  /** A console nobody typed into for this long gives its session back. */
  typingIdleMs: number
  /** How much recent output a watched console keeps for viewers who arrive later. */
  watchLines: number
}
export const CONSOLE_TIMING: ConsoleTiming = { watchIdleMs: 30_000, typingIdleMs: 60_000, watchLines: 2_000 }

interface Watch {
  key: string
  session: Promise<ConsoleSession>
  lines: string[]
  partial: string
  outputs: Set<(data: Buffer) => void>
  closes: Set<(reason: string) => void>
  viewers: number
  idle: ReturnType<typeof setTimeout> | null
  lastSeen: number
}

export class Consoles {
  private readonly watches = new Map<string, Watch>()
  private readonly typing = new Map<string, { session: Promise<ConsoleSession>, timer: ReturnType<typeof setTimeout> | null }>()

  constructor(private readonly lab: BoardLab, private readonly timing: ConsoleTiming = CONSOLE_TIMING) {
    lab.locks.onEnd(board => this.closeTyping(board))
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
      const route = this.lab.backends.route(board, chip.die)
      const opening = route.backend.serial.open(route.config, route.target, { history: true })
      const created: Watch = { key, session: opening, lines: [], partial: '', outputs: new Set(), closes: new Set(), viewers: 0, idle: null, lastSeen: this.lab.kernel.now() }
      watch = created
      this.watches.set(key, created)
      opening.then(session => {
        created.lines = session.history.slice(-this.timing.watchLines)
        session.onOutput(data => {
          const text = created.partial + data.toString('utf8')
          const parts = text.split('\n')
          created.partial = parts.pop() ?? ''
          if (parts.length) created.lines = [...created.lines, ...parts.map(line => line.replace(/\r$/, ''))].slice(-this.timing.watchLines)
          created.outputs.forEach(fn => fn(data))
        })
        session.onClose(reason => { this.drop(created); created.closes.forEach(fn => fn(reason)) })
      }, () => this.drop(created))
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
      history: [...shared.lines, ...(shared.partial ? [shared.partial] : [])],
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
    return { watching: [...this.watches.values()].map(watch => ({ console: watch.key.replace('\0', '.'), viewers: watch.viewers })), typing: this.typing.size }
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
