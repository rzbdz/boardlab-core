/**
 * Restarting boards (reset, or into the boot ROM's download mode) and working their relays and buttons one by one,
 * through the board's backend. A backend that needs a person (a reset button pressed by hand) asks through attention,
 * which the page pops up; whoever is at the board confirms.
 */
import { CHANNEL_ACTIONS, type Channel, type ChannelAction } from './backend.ts'
import { BoardError } from './errors.ts'
import type { BoardLab } from './lab.ts'
import type { Caller } from './locks.ts'

export class Relay {
  /** What a person is asked to do on a board while boardd waits on it. */
  private readonly asked = new Map<string, string>()

  constructor(private readonly lab: BoardLab) {}

  attention(board: string): string | null { return this.asked.get(board) ?? null }

  /** Ask a person to act on a board, or stop asking (null); the page is told at once, to pop up and notify. */
  attend(board: string, message: string | null) {
    const before = this.asked.get(board) ?? null
    if (message) this.asked.set(board, message); else this.asked.delete(board)
    if (before === message) return
    this.lab.kernel.emit({ type: 'attention', board, message, holder: this.lab.locks.held(board)?.holder ?? null })
    this.lab.kernel.changed(board)
  }

  reset(target: string, caller: Caller) { return this.control(target, caller, 'reset') }
  fastboot(target: string, caller: Caller) { return this.control(target, caller, 'fastboot') }

  async control(target: string, caller: Caller, kind: 'reset' | 'fastboot') {
    const lease = this.lab.locks.authorize(target, caller)
    const route = this.lab.backends.route(target)
    const action = kind === 'reset' ? 'reset' : 'download'
    const detail = route.backend.relay.describe?.(route.target, action) ?? `${route.id} ${route.target.device}`
    const notice = (message: string | null) => this.attend(target, message)
    let message: string | null = null
    try {
      if (kind === 'reset') message = (await route.backend.relay.reset(route.config, route.target, notice)) ?? null
      else {
        // A backend that tells the download port only once it appears hands it back here.
        const port = await route.backend.relay.enterDownload(route.config, route.target, notice)
        if (port && route.isBoard) {
          this.lab.boards.upsertChip(target, route.target.die, { download_usb_path: port })
          message = `下载口 ${port}`
        }
      }
    } catch (error) {
      this.lab.kernel.record(lease.holder, target, kind, detail, false, (error as Error).message)
      throw error instanceof BoardError ? error : new BoardError('hardware', (error as Error).message)
    } finally {
      this.attend(target, null)
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

  /** Tell a backend that what a waiting reset asked a person for is done. Whoever is at the board may confirm. */
  async confirm(board: string, actor: string, note = ''): Promise<string> {
    const route = this.lab.backends.route(board)
    const confirm = route.backend.relay.confirm
    if (!confirm) throw new BoardError('invalid', `${board} 没有在等人操作的复位`)
    let message: string
    try { message = await confirm(route.config, route.target, note) }
    catch (error) {
      this.lab.kernel.record(actor, board, 'confirm', note || null, false, (error as Error).message)
      throw new BoardError('hardware', (error as Error).message)
    }
    this.lab.kernel.record(actor, board, 'confirm', note || null, true, message)
    this.lab.kernel.changed(board)
    return message
  }
}
