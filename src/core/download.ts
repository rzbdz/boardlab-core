/**
 * Loading boards through their download port, by the board's backend: one of boardd's own firmware files (`stage`), a
 * RAM boot of files in order (`boot`), or a named build the backend fetches itself (`build`). Only `build` with the
 * `download` method flashes; the rest run from RAM.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import type { Firmware } from '../shared/types.ts'
import type { BootFile, DownloadCapability, LabConfig, BoardTarget } from './backend.ts'
import { BoardError } from './errors.ts'
import { readFirmware, verifiedFirmware } from './firmware.ts'
import type { BoardLab } from './lab.ts'
import type { Caller } from './locks.ts'

/**
 * A RAM boot hands the port from the boot ROM to FSBL, then to U-Boot: each stage needs time to come up and re-enumerate
 * before the next file goes in. `stageMs` bounds loading one file (a kernel FIT is tens of MB).
 */
export interface BootTiming { firstMs: number, laterMs: number, waitMs: number, pollMs: number, stageMs: number }
export const BOOT_TIMING: BootTiming = { firstMs: 8_000, laterMs: 3_000, waitMs: 20_000, pollMs: 500, stageMs: 120_000 }

/** What `boot` and `stage` take as one of boardd's own firmware files rather than a path. */
const FIRMWARE_NAME = /^[a-z0-9][a-z0-9-]*$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/

export class Download {
  /** The latest progress line of a build booting on a board. */
  private readonly progressLines = new Map<string, string>()
  readonly timing: BootTiming

  constructor(private readonly lab: BoardLab, private readonly firmwareDir: string | undefined, timing: Partial<BootTiming> = {}) {
    this.timing = { ...BOOT_TIMING, ...timing }
  }

  firmware(): Firmware[] { return readFirmware(this.firmwareDir) }
  verifiedFirmware(purpose: string, soc: string | null): Firmware { return verifiedFirmware(this.firmwareDir, purpose, soc) }
  progress(board: string): string | null { return this.progressLines.get(board) ?? null }

  /** The board's chip with a download port, and its backend addressing it. */
  private port(board: string, die: string | undefined) {
    const target = this.lab.boards.get(board)
    const chip = die ? target.chips.find(item => item.die === die) : target.chips[0]
    if (!chip?.downloadUsbPath) throw new BoardError('invalid', `${board} 没有登记下载口`)
    return { board: target, chip, route: this.lab.backends.route(board, chip.die) }
  }

  private unknown(board: string) {
    this.lab.boards.setMode(board, 'unknown')
    this.lab.kernel.changed(board)
  }

  /** Load one of boardd's own firmware files into a chip's RAM through its download port. Never flashes. */
  async stage(board: string, caller: Caller, input: { die?: string, firmware: string }): Promise<string> {
    const lease = this.lab.locks.authorize(board, caller)
    const { board: target, chip, route } = this.port(board, input.die)
    const image = this.verifiedFirmware(input.firmware, target.soc)
    try {
      const output = await route.backend.download.stage(route.config, route.target, image)
      this.lab.kernel.record(lease.holder, board, 'stage', `${chip.die}: ${image.purpose} ${image.sha256.slice(0, 12)}`, true)
      this.unknown(board)
      return output
    } catch (error) {
      this.lab.kernel.record(lease.holder, board, 'stage', `${chip.die}: ${image.purpose}`, false, (error as Error).message)
      throw new BoardError('hardware', (error as Error).message)
    }
  }

  /**
   * Boot a chip from RAM through its download port: stage each file in order (FSBL, U-Boot/OpenSBI, kernel), waiting for
   * the port to come back between them. A bare name is one of boardd's own firmware files, `sha256:<hex>` a file a remote
   * CLI sent, and anything else a file on this machine. Never flashes.
   */
  async boot(board: string, caller: Caller, input: { die?: string, files: string[] }): Promise<string> {
    const lease = this.lab.locks.authorize(board, caller)
    const { board: target, chip, route } = this.port(board, input.die)
    if (!input.files.length) throw new BoardError('invalid', '要按顺序给出启动文件，例如 fsbl u-boot-opensbi /path/Image.itb')
    const files: BootFile[] = input.files.map(path => {
      if (FIRMWARE_NAME.test(path)) { const firmware = this.verifiedFirmware(path, target.soc); return { path: firmware.path, sha256: firmware.sha256 } }
      const sent = path.match(/^sha256:([0-9a-f]{64})$/)
      if (sent) return this.lab.files.resolve(sent[1]!)
      if (!isAbsolute(path)) throw new BoardError('invalid', `启动文件要用绝对路径或 boardd 自带固件的名字：${path}`)
      let data: Buffer
      try { data = readFileSync(path) } catch { throw new BoardError('invalid', `读不到启动文件：${path}`) }
      if (!data.length) throw new BoardError('invalid', `启动文件是空的：${path}`)
      return { path, sha256: createHash('sha256').update(data).digest('hex') }
    })
    const listing = files.map((file, index) => `${index + 1}. ${file.path} sha256 ${file.sha256}`)
    const download = route.backend.download
    if (download.boot) {
      // The backend runs the whole sequence, under its own busy guard and log.
      const names = files.map((file, index) => `${index + 1}/${files.length} ${basename(file.path)} ${file.sha256.slice(0, 12)}`).join('，')
      try {
        const output = await download.boot(route.config, route.target, files, this.timing)
        this.lab.kernel.record(lease.holder, board, 'boot', `${chip.die}: ${names}`, true, files.map(file => file.path).join(' '))
        return [...listing, output].join('\n')
      } catch (error) {
        this.lab.kernel.record(lease.holder, board, 'boot', `${chip.die}: ${names}`, false, (error as Error).message)
        throw new BoardError('hardware', `实验室没能内存启动：${(error as Error).message}`)
      } finally { this.unknown(board) }
    }
    const outputs: string[] = []
    try {
      for (const [index, file] of files.entries()) {
        const step = `${chip.die}: ${index + 1}/${files.length} ${basename(file.path)} ${file.sha256.slice(0, 12)}`
        try {
          if (index) await this.portBack(download, route.config, route.target, index === 1 ? this.timing.firstMs : this.timing.laterMs)
          outputs.push(await download.stage(route.config, route.target, file, this.timing.stageMs))
          this.lab.kernel.record(lease.holder, board, 'boot', step, true, file.path)
        } catch (error) {
          this.lab.kernel.record(lease.holder, board, 'boot', step, false, (error as Error).message)
          throw new BoardError('hardware', `第 ${index + 1} 个文件 ${file.path} 没有加载成功：${(error as Error).message}`)
        }
      }
    } finally { this.unknown(board) }
    return [...listing, ...outputs].join('\n')
  }

  /** Wait for the stage just started to bring the download port back. */
  private async portBack(download: DownloadCapability, config: LabConfig, target: BoardTarget, settleMs: number): Promise<void> {
    await this.lab.kernel.sleep(settleMs)
    for (let waited = 0; ; waited += this.timing.pollMs) {
      if (await download.present(config, target)) return
      if (waited >= this.timing.waitMs) throw new Error(`下载口 ${target.usbPath} 在 ${(settleMs + this.timing.waitMs) / 1000} 秒内没有重新出现，上一个文件可能没有起来；看串口日志`)
      await this.lab.kernel.sleep(this.timing.pollMs)
    }
  }

  /**
   * Boot a board with a named build: from RAM (`load`) or by flashing it (`download`). The backend gets the build to the
   * board itself (bsp: the board host pulls it from the build server), so nothing passes through here.
   */
  async build(board: string, caller: Caller, input: { sdk: string, method?: 'load' | 'download', variant?: string | null }): Promise<string> {
    const lease = this.lab.locks.authorize(board, caller)
    const route = this.lab.backends.route(board)
    const builds = route.backend.builds
    if (!builds) throw new BoardError('invalid', `${board} 所在的后端 ${route.id} 不能用 SDK 启动板子；用 boardlab boot ${board} <文件>… 从文件启动`)
    if (!NAME.test(input.sdk)) throw new BoardError('invalid', `SDK 名不合法：${input.sdk}`)
    if (input.variant && !NAME.test(input.variant)) throw new BoardError('invalid', `variant 不合法：${input.variant}`)
    const method = input.method ?? 'load'
    const known = this.lab.backends.builds(board)
    if (known.length && !known.includes(input.sdk)) throw new BoardError('invalid', `${board} 不能跑 SDK ${input.sdk}（可以：${known.join('、')}）`)
    const detail = `${input.sdk} ${method === 'download' ? '刷机' : '内存启动'}${input.variant ? ` ${input.variant}` : ''}`
    const progress = (line: string) => {
      this.progressLines.set(board, line.replace(/^\s*\[\s*[\d.]+s\]\s*/, '').slice(0, 200))
      const asked = line.match(/ACTION NEEDED: (.*)$/)
      if (asked) this.lab.relay.attend(board, asked[1]!)
      else if (/: (confirmed by a person|detected )/.test(line)) this.lab.relay.attend(board, null)
      this.lab.kernel.changed(board)
    }
    try {
      const output = await builds.boot(route.config, route.target, { sdk: input.sdk, method, variant: input.variant ?? null }, progress)
      this.lab.kernel.record(lease.holder, board, method === 'download' ? 'flash' : 'boot', detail, true)
      return output
    } catch (error) {
      this.lab.kernel.record(lease.holder, board, method === 'download' ? 'flash' : 'boot', detail, false, (error as Error).message)
      throw new BoardError('hardware', `${detail}没有成功：${(error as Error).message}`)
    } finally {
      this.progressLines.delete(board)
      this.lab.relay.attend(board, null)
      this.unknown(board)
    }
  }
}
