/**
 * Renaming a board everywhere. The backend that names the board itself (a lab's DUT and console alias, this machine's
 * serial-mux daemons) is the dependency: it is asked first, and boardd's own record changes only once every part of it
 * succeeded. A per-chip rename that fails halfway is put back where it was, so a retry starts from the old name
 * everywhere; a whole-board rename that the backend answers with an unusable name is given its old name back.
 */
import type { Backend, BoardTarget, LabConfig, LabDevice } from './backend.ts'
import { transaction } from './db.ts'
import { BoardError } from './errors.ts'
import type { BoardLab } from './lab.ts'
import type { Caller } from './locks.ts'
import { BOARD_NAME, str } from './text.ts'

/** What renaming needs from the backend registry (see Backends). */
export interface RenameHost {
  lab: BoardLab
  /** The backend's last listing of its boards, kept in step by the registry. */
  devices: Map<string, LabDevice>
  /** The last lease failure per board, so a page keeps showing it after the name changes. */
  leaseErrors: Map<string, string>
  /** The backend a target is on, and how it addresses it. */
  route(target: string, die?: string): { id: string, backend: Backend, config: LabConfig, isBoard: boolean, target: BoardTarget }
  /** List an instance's boards again after the rename. */
  sync(id: string): Promise<void>
}

export async function renameBoard(host: RenameHost, actor: string, board: string, to: string, caller: Caller): Promise<{ board: string, message: string }> {
  const lab = host.lab
  const db = lab.kernel.db
  const current = lab.boards.get(board)
  if (host.devices.get(board)?.empty) throw new BoardError('invalid', `${board} 是空槽位，没有板子可改名`)
  const busy = lab.kernel.busy.get(board)
  if (busy) throw new BoardError('conflict', `${board} 正在${busy.label.replace(/中$/, '')}，等它完成`)
  if (lab.locks.held(board)) lab.locks.authorize(board, caller)
  const route = host.route(board)
  const instance = route.isBoard ? str(db.prepare('SELECT lab FROM boards WHERE name=?').get(board)?.lab) : null
  const prefix = instance ? `${instance}-` : ''
  const wanted = to.trim()
  if (!wanted) throw new BoardError('invalid', '新名字不能为空')
  let name = prefix && !wanted.startsWith(prefix) ? `${prefix}${wanted}` : wanted
  let device = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name
  const oldDevice = prefix && board.startsWith(prefix) ? board.slice(prefix.length) : board
  if (!BOARD_NAME.test(name) || !BOARD_NAME.test(device)) throw new BoardError('invalid', `板名不合法：${wanted}`)
  if (name === board) return { board, message: '名字没有变' }
  if (lab.boards.exists(name)) throw new BoardError('conflict', `已有板子 ${name}`)
  let message = `${board} → ${name}`
  const aliases: Array<{ die: string, alias: string }> = []
  if (route.backend.rename) {
    const done: Array<{ target: BoardTarget, from: string, to: string }> = []
    try {
      if (route.backend.rename.perChip) {
        for (const chip of current.chips) {
          const target = { ...host.route(board, chip.die).target, device: oldDevice }
          const result = await route.backend.rename.rename(route.config, target, device)
          const alias = result.alias ?? device
          if (alias !== target.port) done.push({ target, from: target.port ?? target.board, to: alias })
          aliases.push({ die: chip.die, alias })
        }
      } else {
        const result = await route.backend.rename.rename(route.config, { ...route.target, device: oldDevice }, device)
        device = result.device ?? device
        if (result.alias && current.chips.length) aliases.push({ die: current.chips[0]!.die, alias: result.alias })
        message = result.message ?? message
      }
    } catch (error) {
      const stuck: string[] = []
      for (const item of done.reverse()) {
        try {
          // Rename it back the way it was renamed: the new name as the board, the old one as where it came from.
          await route.backend.rename.rename(route.config, { ...item.target, board: name, port: item.to }, item.from)
        } catch { stuck.push(item.to) }
      }
      const why = `${(error as Error).message}${stuck.length ? `；${stuck.join('、')} 没有改回去，下次同步时以实验室为准` : ''}`
      lab.kernel.record(actor, board, 'rename', `${board} → ${name}`, false, why)
      throw new BoardError('hardware', `改名失败：${why}`)
    }
  }
  // A backend may settle on a name of its own (sanitized, or the one it had): the board follows it.
  name = prefix ? `${prefix}${device}` : device
  const unplaceable = !BOARD_NAME.test(name) || !BOARD_NAME.test(device)
    ? `后端给的新名字不合法：${device}` : name !== board && lab.boards.exists(name) ? `后端给的新名字 ${name} 和已有的板子重名` : null
  if (unplaceable) {
    if (route.backend.rename && !route.backend.rename.perChip) {
      await route.backend.rename.rename(route.config, { ...route.target, device }, oldDevice).catch(() => {})
    }
    lab.kernel.record(actor, board, 'rename', `${board} → ${name}`, false, unplaceable)
    throw new BoardError('hardware', `改名失败：${unplaceable}`)
  }
  transaction(db, () => {
    lab.boards.rename(board, name)
    if (route.isBoard && instance) db.prepare('UPDATE boards SET lab_device=?, lab_token=NULL WHERE name=?').run(device, name)
    for (const item of aliases) db.prepare('UPDATE chips SET alias=? WHERE board=? AND die=?').run(item.alias, name, item.die)
    const seen = host.devices.get(board)
    if (seen) { host.devices.delete(board); host.devices.set(name, seen) }
    const failure = host.leaseErrors.get(board)
    if (failure !== undefined) { host.leaseErrors.delete(board); host.leaseErrors.set(name, failure) }
  })
  lab.kernel.record(actor, name, 'rename', `${board} → ${name}`, true, message)
  lab.kernel.changed(board)
  lab.kernel.changed(name)
  // A lab lease dropped by its rename is taken again, and the serial gates follow the lock under the new name.
  const failures = await lab.locks.settle(name).catch(() => [])
  if (failures.length) message += `；${failures.join('；')}`
  if (route.isBoard && instance) await host.sync(route.id).catch(() => {})
  return { board: name, message }
}
