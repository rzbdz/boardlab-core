/**
 * Loading boards through their download port, by the board's backend: one of boardd's own firmware files (`stage`), a
 * RAM boot of files in order (`boot`), a named build the backend fetches itself (`build`), or a flash package
 * (`flashPackage`). Only `build` with the `download` method and `flashPackage` flash; the rest run from RAM.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import type { Firmware } from '../shared/types.ts'
import { DEFAULT_PACKAGES, takesPackage, type BootFile, type DownloadCapability, type FlashPackage, type LabConfig, type BoardTarget, type FlashPlan, type PackageKinds, type RunReport } from './backend.ts'
import { BoardError, CancelledError, isCancelled } from './errors.ts'
import { firmwareOf, verifiedFirmware } from './firmware.ts'
import { askedIn } from './relay.ts'
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

/** A package as a caller names it: a market's image, a link, or a file sent to boardd (by sha256); one of them. */
export interface PackageInput { url?: string | null, sha256?: string | null, image?: { market: string, path: string } | null, flasher?: string | null, refresh?: boolean }

export class Download {
  /** The latest progress line of a build booting on a board. */
  private readonly progressLines = new Map<string, string>()
  readonly timing: BootTiming

  /** Firmware a module added at start (a vendor's own), on top of the release's `firmware/`. */
  private readonly added: Firmware[] = []

  constructor(private readonly lab: BoardLab, private readonly firmwareDir: string | undefined, timing: Partial<BootTiming> = {}) {
    this.timing = { ...BOOT_TIMING, ...timing }
  }

  /** Add firmware a module brings; returns the way to take it back. */
  addFirmware(images: Firmware[]): () => void {
    this.added.push(...images)
    return () => { for (const image of images) { const at = this.added.indexOf(image); if (at >= 0) this.added.splice(at, 1) } }
  }

  firmware(): Firmware[] { return firmwareOf(this.firmwareDir, this.added) }
  verifiedFirmware(purpose: string, soc: string | null): Firmware { return verifiedFirmware(this.firmware(), purpose, soc) }
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
  async stage(board: string, caller: Caller, input: { die?: string, firmware: string }, signal?: AbortSignal): Promise<string> {
    const lease = this.lab.locks.authorize(board, caller)
    const { board: target, chip, route } = this.port(board, input.die)
    const image = this.verifiedFirmware(input.firmware, target.soc)
    try {
      const output = await route.backend.download.stage(route.config, route.target, image, undefined, signal)
      this.lab.kernel.record(lease.holder, board, 'stage', `${chip.die}: ${image.purpose} ${image.sha256.slice(0, 12)}`, true)
      this.unknown(board)
      return output
    } catch (error) {
      const failure = failed(error, signal)
      this.lab.kernel.record(lease.holder, board, 'stage', `${chip.die}: ${image.purpose}`, false, failure.message)
      throw failure
    }
  }

  /**
   * Boot a chip from RAM through its download port: stage each file in order (FSBL, U-Boot/OpenSBI, kernel), waiting for
   * the port to come back between them. A bare name is one of boardd's own firmware files, `sha256:<hex>` a file a remote
   * CLI sent. A backend that declares `backendFiles` can also fetch an HTTP(S) URL or read `host:/absolute/path`
   * itself. Anything else is a file on this machine. Never flashes.
   */
  async boot(board: string, caller: Caller, input: { die?: string, files: string[] }, signal?: AbortSignal): Promise<string> {
    const lease = this.lab.locks.authorize(board, caller)
    const { board: target, chip, route } = this.port(board, input.die)
    if (!input.files.length) throw new BoardError('invalid', '要按顺序给出启动文件，例如 fsbl u-boot-opensbi /path/Image.itb')
    const files: BootFile[] = input.files.map(path => {
      if (FIRMWARE_NAME.test(path)) { const firmware = this.verifiedFirmware(path, target.soc); return { path: firmware.path, sha256: firmware.sha256 } }
      const sent = path.match(/^sha256:([0-9a-f]{64})$/)
      if (sent) return this.lab.files.resolve(sent[1]!)
      if (/^https?:\/\//i.test(path) || path.startsWith('host:')) {
        if (!route.backend.download.boot || !route.backend.download.backendFiles) throw new BoardError('invalid', '这个实验室不能从 URL 或板卡主机路径启动；用 SDK 配方，或把本机文件传上来')
        if (path.startsWith('host:')) {
          const hostPath = path.slice(5)
          if (!isAbsolute(hostPath)) throw new BoardError('invalid', `板卡主机路径要写成 host:/绝对路径：${path}`)
          return { path: hostPath, sha256: '', source: 'backend' }
        }
        const url = packageUrl(path, DEFAULT_PACKAGES)
        return { path: url.href, sha256: '', source: 'backend' }
      }
      if (!isAbsolute(path)) throw new BoardError('invalid', `启动文件要用绝对路径或 boardd 自带固件的名字：${path}`)
      let data: Buffer
      try { data = readFileSync(path) } catch { throw new BoardError('invalid', `读不到启动文件：${path}`) }
      if (!data.length) throw new BoardError('invalid', `启动文件是空的：${path}`)
      return { path, sha256: createHash('sha256').update(data).digest('hex') }
    })
    const listing = files.map((file, index) => `${index + 1}. ${file.path}${file.sha256 ? ` sha256 ${file.sha256}` : '（板卡主机读取并校验）'}`)
    const download = route.backend.download
    if (download.boot) {
      // The backend runs the whole sequence, under its own busy guard and log.
      const names = files.map((file, index) => `${index + 1}/${files.length} ${basename(file.path)} ${file.sha256.slice(0, 12) || '板卡主机取文件'}`).join('，')
      try {
        const output = await download.boot(route.config, route.target, files, this.timing, signal)
        this.lab.kernel.record(lease.holder, board, 'boot', `${chip.die}: ${names}`, true, files.map(file => file.path).join(' '))
        return [...listing, output].join('\n')
      } catch (error) {
        const failure = failed(error, signal, '实验室没能内存启动：')
        this.lab.kernel.record(lease.holder, board, 'boot', `${chip.die}: ${names}`, false, failure.message)
        throw failure
      } finally { this.unknown(board) }
    }
    const outputs: string[] = []
    try {
      for (const [index, file] of files.entries()) {
        const step = `${chip.die}: ${index + 1}/${files.length} ${basename(file.path)} ${file.sha256.slice(0, 12)}`
        try {
          // Each file is a step: a cancel takes effect before the next one starts.
          stopped(signal)
          if (index) await this.portBack(download, route.config, route.target, index === 1 ? this.timing.firstMs : this.timing.laterMs, signal)
          outputs.push(await download.stage(route.config, route.target, file, this.timing.stageMs, signal))
          this.lab.kernel.record(lease.holder, board, 'boot', step, true, file.path)
        } catch (error) {
          const failure = failed(error, signal, `第 ${index + 1} 个文件 ${file.path} 没有加载成功：`)
          this.lab.kernel.record(lease.holder, board, 'boot', step, false, failure.message)
          throw failure
        }
      }
    } finally { this.unknown(board) }
    return [...listing, ...outputs].join('\n')
  }

  /** Wait for the stage just started to bring the download port back. */
  private async portBack(download: DownloadCapability, config: LabConfig, target: BoardTarget, settleMs: number, signal?: AbortSignal): Promise<void> {
    await this.lab.kernel.sleep(settleMs)
    for (let waited = 0; ; waited += this.timing.pollMs) {
      stopped(signal)
      if (await download.present(config, target)) return
      if (waited >= this.timing.waitMs) throw new Error(`下载口 ${target.usbPath} 在 ${(settleMs + this.timing.waitMs) / 1000} 秒内没有重新出现，上一个文件可能没有起来；看串口日志`)
      await this.lab.kernel.sleep(this.timing.pollMs)
    }
  }

  /**
   * Boot a board with a named build: from RAM (`load`) or by flashing it (`download`). The backend gets the build to the
   * board itself (a board host pulls it from its build server), so nothing passes through here.
   */
  async build(board: string, caller: Caller, input: { sdk: string, method?: 'load' | 'download', variant?: string | null, brk?: string | null }, signal?: AbortSignal, line?: (text: string) => void, report?: RunReport): Promise<string> {
    const lease = this.lab.locks.authorize(board, caller)
    const route = this.lab.backends.route(board)
    const builds = route.backend.builds
    if (!builds) throw new BoardError('invalid', `${board} 所在的后端 ${route.id} 不能用 SDK 启动板子；用 boardlab boot ${board} <文件>… 从文件启动`)
    if (!NAME.test(input.sdk)) throw new BoardError('invalid', `SDK 名不合法：${input.sdk}`)
    if (input.variant && !NAME.test(input.variant)) throw new BoardError('invalid', `variant 不合法：${input.variant}`)
    if (input.brk && !NAME.test(input.brk)) throw new BoardError('invalid', `break point 不合法：${input.brk}`)
    const method = input.method ?? 'load'
    const known = this.lab.backends.builds(board)
    if (known.length && !known.includes(input.sdk)) throw new BoardError('invalid', `${board} 不能跑 SDK ${input.sdk}（可以：${known.join('、')}）`)
    const detail = `${input.sdk} ${method === 'download' ? '刷机' : '内存启动'}${input.variant ? ` ${input.variant}` : ''}${input.brk ? ` 停在 ${input.brk}` : ''}`
    try {
      const output = await builds.boot(route.config, route.target, { sdk: input.sdk, method, variant: input.variant ?? null, brk: input.brk ?? null }, this.follow(board, line), signal, report)
      this.lab.kernel.record(lease.holder, board, method === 'download' ? 'flash' : 'boot', detail, true)
      return output
    } catch (error) {
      const failure = failed(error, signal, `${detail}没有成功：`)
      this.lab.kernel.record(lease.holder, board, method === 'download' ? 'flash' : 'boot', detail, false, failure.message)
      throw failure
    } finally { this.ended(board) }
  }

  /**
   * Flash a board with a package: an http(s) `url` the backend downloads itself, or a file sent to boardd (`sha256`,
   * bare or as `sha256:<hex>`). `flasher` names the backend's tool to write it with; `refresh` asks it to download a link again rather than use a copy it cached. `line` gets each progress line.
   */
  async flashPackage(board: string, caller: Caller, input: PackageInput & { partitions?: string[] | null, reset?: boolean }, signal?: AbortSignal, line?: (text: string) => void, report?: RunReport): Promise<string> {
    const lease = this.lab.locks.authorize(board, caller)
    const route = this.lab.backends.route(board)
    const builds = route.backend.builds
    if (!builds?.flash) throw new BoardError('invalid', `${board} 所在的后端 ${route.id} 不能用刷机包刷机`)
    const partitions = input.partitions?.length ? input.partitions : null
    if (partitions?.some(name => !NAME.test(name))) throw new BoardError('invalid', `分区名不合法：${partitions.join(',')}`)
    const { pkg, what } = await this.package(board, builds.accepts ?? DEFAULT_PACKAGES, input, signal, line)
    if (partitions) pkg.partitions = partitions
    const detail = `刷机包 ${what}${pkg.flasher ? `（${pkg.flasher}）` : ''}${partitions ? `，只刷 ${partitions.join('、')}` : ''}`
    let output: string
    // A file of the store stays while its flash reads it, however long ago it was sent.
    const release = pkg.path ? this.lab.files.hold(pkg.path) : () => {}
    try {
      output = await builds.flash!(route.config, route.target, pkg, this.follow(board, line), signal, report)
      this.lab.kernel.record(lease.holder, board, 'flash', detail, true)
    } catch (error) {
      const failure = failed(error, signal, `${detail} 没有刷成功：`)
      this.lab.kernel.record(lease.holder, board, 'flash', detail, false, failure.message)
      throw failure
    } finally { release(); this.ended(board) }
    if (!input.reset) return output
    // Written: a reset boots what was written, as the board's own reset does it (its media, through the backend).
    // A reset refused (the lock given back during the flash) or failed leaves the flash written, and says so.
    line?.('刷完了，复位板子')
    try { await this.lab.relay.reset(board, caller, signal) }
    catch (error) { return `${output}\n刷好了，但没有复位：${(error as Error).message}` }
    return `${output}\n已复位 ${board}`
  }

  /**
   * What flashing a package onto `board` would write, as its backend reads the package (fetching it first, when it has
   * to): media and partitions, and whether some can be written alone. Under the board's lock; nothing is written.
   */
  async plan(board: string, caller: Caller, input: PackageInput, signal?: AbortSignal, line?: (text: string) => void): Promise<FlashPlan> {
    this.lab.locks.authorize(board, caller)
    const route = this.lab.backends.route(board)
    const builds = route.backend.builds
    if (!builds?.flash) throw new BoardError('invalid', `${board} 所在的后端 ${route.id} 不能用刷机包刷机`)
    if (!builds.plan) throw new BoardError('invalid', `${board} 所在的后端 ${route.id} 不能先看刷机包里有什么`)
    const { pkg } = await this.package(board, builds.accepts ?? DEFAULT_PACKAGES, input, signal, line)
    const release = pkg.path ? this.lab.files.hold(pkg.path) : () => {}
    try { return await builds.plan(route.config, route.target, pkg, text => line?.(text), signal) }
    catch (error) { throw failed(error, signal, '看不了刷机包里有什么：') }
    finally { release() }
  }

  /** The package an input names, checked against what the board's backend takes, and how the log names it. */
  private async package(board: string, kinds: PackageKinds, input: PackageInput, signal?: AbortSignal, line?: (text: string) => void): Promise<{ pkg: FlashPackage, what: string }> {
    if (input.image) {
      // An image of a market: where it is fetched from, and the sha256 it must have when the market knows it.
      if (input.url || input.sha256) throw new BoardError('invalid', '刷机包给市场里的镜像、链接或传上来的文件，三选一')
      const found = await this.lab.markets.locate(input.image.market, input.image.path, signal)
      line?.(`镜像 ${input.image.market}:${input.image.path}`)
      input = { ...input, image: null, url: found.url, sha256: found.sha256 ?? null }
    }
    const sha256 = input.sha256 ? input.sha256.replace(/^sha256:/, '') : null
    if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) throw new BoardError('invalid', `sha256 不对：${input.sha256}`)
    if (!input.url && !sha256) throw new BoardError('invalid', `刷机包要给链接（${kinds.schemes.join('、')}）或传上来的文件`)
    if (input.flasher && !NAME.test(input.flasher)) throw new BoardError('invalid', `刷机工具名不合法：${input.flasher}`)
    const flasher = input.flasher || null
    if (input.url) {
      const url = packageUrl(input.url, kinds)
      // The log names the package without its query, which may carry a signed URL's token.
      const what = url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}${url.pathname}` : `${url.protocol}//${url.host}${url.pathname}`
      if (!takesPackage(kinds, url.href, url.pathname)) throw new BoardError('invalid', `${board} 所在的后端刷不了这种包：${what}（它刷 ${kinds.suffixes.join('、')}）`)
      return { pkg: { url: url.href, flasher, ...(sha256 ? { sha256 } : {}), ...(input.refresh ? { refresh: true } : {}) }, what }
    }
    const file = this.lab.files.resolve(sha256!)
    if (!takesPackage(kinds, null, file.path)) throw new BoardError('invalid', `${board} 所在的后端刷不了这种包：${basename(file.path)}（它刷 ${kinds.suffixes.join('、')}）`)
    return { pkg: { path: file.path, sha256: file.sha256, flasher }, what: `${basename(file.path)} ${file.sha256.slice(0, 12)}` }
  }

  /** The progress of a backend's build or flash: shown on the board, with what a person is asked to do. */
  follow(board: string, line?: (text: string) => void) {
    return (text: string) => {
      const shown = text.replace(/^\s*\[\s*[\d.]+s\]\s*/, '').slice(0, 200)
      this.progressLines.set(board, shown)
      line?.(shown)
      const asked = askedIn(text)
      if (asked) this.lab.relay.attend(board, asked.message, asked.request)
      else if (/: (confirmed by a person|detected )/.test(text)) this.lab.relay.attend(board, null)
      this.lab.kernel.changed(board)
    }
  }

  /** A backend's build or flash ended: its progress goes, and what the board runs now is unknown. */
  ended(board: string) {
    this.progressLines.delete(board)
    this.lab.relay.attend(board, null)
    this.unknown(board)
  }
}

/** A cancelled run ends here, before its next step. */
function stopped(signal?: AbortSignal) {
  if (signal?.aborted && signal.reason instanceof CancelledError && !signal.reason.refused) throw signal.reason
}

/**
 * What a load or flash that threw reports: a cancel as itself (已取消, whatever the backend said), a failure of the
 * hardware with `prefix` before the backend's words.
 */
function failed(error: unknown, signal: AbortSignal | undefined, prefix = ''): BoardError {
  if (isCancelled(error, signal)) return error instanceof CancelledError ? error : signal!.reason as CancelledError
  return new BoardError('hardware', `${prefix}${(error as Error).message}`)
}

/**
 * A package's address: in a scheme the backend fetches (`kinds`), with no password in it (a backend's host fetches it;
 * logs show it). A user name stays, for schemes that log in as one (an ssh copy's `user@host`).
 */
function packageUrl(text: string, kinds: PackageKinds): URL {
  let url: URL
  try { url = new URL(text.trim()) } catch { throw new BoardError('invalid', `刷机包链接不对：${text}`) }
  const scheme = url.protocol.replace(/:$/, '')
  if (!kinds.schemes.includes(scheme)) throw new BoardError('invalid', `刷机包链接要以 ${kinds.schemes.map(s => `${s}://`).join(' 或 ')} 开头：${text}`)
  if (url.password || ((scheme === 'http' || scheme === 'https') && url.username)) throw new BoardError('invalid', '刷机包链接里不能带账号密码')
  return url
}
