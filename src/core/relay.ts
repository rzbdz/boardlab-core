/**
 * Restarting boards (reset, or into the boot ROM's download mode) and working their relays and buttons one by one,
 * through the board's backend. A backend that needs a person (a reset button pressed by hand) asks through attention,
 * which the page pops up; whoever is at the board confirms.
 */
import { CHANNEL_ACTIONS, type Channel, type ChannelAction } from './backend.ts'
import { BoardError } from './errors.ts'
import type { BoardLab } from './lab.ts'
import type { Caller } from './locks.ts'

/**
 * What a backend asks a person for, from a progress line: `ACTION NEEDED: press RESET … (request ab12cd34ef56)`.
 * Backends that name their asks put the id in it, and the page sends it back with the confirmation.
 */
export function askedIn(line: string): { message: string, request: string | null } | null {
  const asked = line.match(/ACTION NEEDED(?::| \(board \d+\):)\s*(.*)$/)
  if (!asked) return null
  const named = asked[1]!.match(/^(.*?)\s*\(request ([0-9a-f]{6,32})\)\s*$/)
  return named ? { message: named[1]!, request: named[2]! } : { message: asked[1]!, request: null }
}

export class Relay {
  /** What a person is asked to do on a board while boardd waits on it, and the backend's id for that ask. */
  private readonly asked = new Map<string, { message: string, request: string | null }>()

  constructor(private readonly lab: BoardLab) {}

  attention(board: string): string | null { return this.asked.get(board)?.message ?? null }

  /** The backend's id for the ask waiting on a board (null when the backend does not name its asks). */
  request(board: string): string | null { return this.asked.get(board)?.request ?? null }

  /** Ask a person to act on a board, or stop asking (null); the page is told at once, to pop up and notify. */
  attend(board: string, message: string | null, request: string | null = null) {
    const before = this.asked.get(board) ?? null
    const named = message ? request ?? before?.request ?? null : null
    if (message) this.asked.set(board, { message, request: named }); else this.asked.delete(board)
    // The same ask again (the command line and the poller both report it) is not a new one.
    if ((before?.message ?? null) === message && (before?.request ?? null) === named) return
    this.lab.kernel.emit({ type: 'attention', board, message, request: named, holder: this.lab.locks.held(board)?.holder ?? null })
    this.lab.kernel.changed(board)
  }

  /**
   * Ask a person on behalf of one run until `done`. Once the lock it runs under ends (`signal`) the ask is withdrawn and
   * the run asks nothing more, so it never touches what the next holder's run asks.
   */
  asking(board: string, signal?: AbortSignal) {
    const live = () => !signal?.aborted
    signal?.addEventListener('abort', () => this.attend(board, null), { once: true })
    return {
      notice: (message: string | null, request?: string | null) => { if (live()) this.attend(board, message, request ?? null) },
      done: () => { if (live()) this.attend(board, null) },
    }
  }

  /** `signal` stops a backend still waiting (for a person, say): the lock it runs under ended. */
  reset(target: string, caller: Caller, signal?: AbortSignal) { return this.control(target, caller, 'reset', signal) }
  fastboot(target: string, caller: Caller, signal?: AbortSignal) { return this.control(target, caller, 'fastboot', signal) }

  async control(target: string, caller: Caller, kind: 'reset' | 'fastboot', signal?: AbortSignal) {
    const lease = this.lab.locks.authorize(target, caller)
    const route = this.lab.backends.route(target)
    const action = kind === 'reset' ? 'reset' : 'download'
    const detail = route.backend.relay.describe?.(route.target, action) ?? `${route.id} ${route.target.device}`
    const { notice, done } = this.asking(target, signal)
    let message: string | null = null
    try {
      if (kind === 'reset') message = (await route.backend.relay.reset(route.config, route.target, notice, signal)) ?? null
      else {
        // A backend that tells the download port only once it appears hands it back here.
        const port = await route.backend.relay.enterDownload(route.config, route.target, notice, signal)
        if (port && route.isBoard) {
          this.lab.boards.upsertChip(target, route.target.die, { download_usb_path: port })
          message = `下载口 ${port}`
        }
      }
    } catch (error) {
      this.lab.kernel.record(lease.holder, target, kind, detail, false, (error as Error).message)
      throw error instanceof BoardError ? error : new BoardError('hardware', (error as Error).message)
    } finally {
      done()
    }
    this.lab.kernel.record(lease.holder, target, kind, detail, true, message)
    if (route.isBoard) this.lab.boards.setMode(target, kind === 'reset' ? 'normal' : 'fastboot')
    this.lab.kernel.changed(target)
  }

  /** A board's relays and buttons, as its backend's relay controller has them; none for a backend without channels. */
  async channels(board: string): Promise<{ board: string, supported: boolean, channels: Channel[] }> {
    const route = this.lab.backends.route(board)
    if (!route.backend.channels || !route.isBoard) return { board, supported: false, channels: [] }
    try { return { board, supported: true, channels: await route.backend.channels.list(route.config, route.target) } }
    catch (error) { throw new BoardError('hardware', (error as Error).message) }
  }

  /** Work one of a board's channels, under its lock: switch a relay, press or click a button. */
  async setChannel(board: string, caller: Caller, input: { channel: string, action: ChannelAction, ms?: number | null }): Promise<string> {
    const lease = this.lab.locks.authorize(board, caller)
    if (!CHANNEL_ACTIONS.includes(input.action)) throw new BoardError('invalid', `不认识的动作：${input.action}（可以：${CHANNEL_ACTIONS.join('、')}）`)
    if (!/^[A-Za-z0-9_.:/-]{1,120}$/.test(input.channel)) throw new BoardError('invalid', `通道名不合法：${input.channel}`)
    const ms = input.ms ?? null
    if (ms !== null && (!Number.isInteger(ms) || ms < 1 || ms > 600_000)) throw new BoardError('invalid', `时长不合法：${ms} ms`)
    const route = this.lab.backends.route(board)
    if (!route.backend.channels || !route.isBoard) throw new BoardError('invalid', `${board} 所在的后端 ${route.id} 不能单独控制继电器`)
    const detail = `${input.channel} ${input.action}${ms !== null ? ` ${ms}ms` : ''}`
    let message: string
    try { message = await route.backend.channels.set(route.config, route.target, input.channel, input.action, ms) }
    catch (error) {
      this.lab.kernel.record(lease.holder, board, 'relay', detail, false, (error as Error).message)
      throw new BoardError('hardware', (error as Error).message)
    }
    this.lab.kernel.record(lease.holder, board, 'relay', detail, true, message)
    this.lab.boards.setMode(board, 'unknown')
    this.lab.kernel.changed(board)
    return message
  }

  /**
   * Tell a backend that what a waiting reset asked a person for is done. Whoever is at the board may confirm. `request`
   * names the ask for a backend that ids them: the same request answered again says so instead of failing.
   */
  async confirm(board: string, actor: string, note = '', request: string | null = null): Promise<string> {
    const route = this.lab.backends.route(board)
    const confirm = route.backend.relay.confirm
    if (!confirm) throw new BoardError('invalid', `${board} 没有在等人操作的复位`)
    let message: string
    try { message = await confirm(route.config, route.target, note, request) }
    catch (error) {
      this.lab.kernel.record(actor, board, 'confirm', note || null, false, (error as Error).message)
      throw new BoardError('hardware', (error as Error).message)
    }
    this.lab.kernel.record(actor, board, 'confirm', note || null, true, message)
    this.lab.kernel.changed(board)
    return message
  }
}
