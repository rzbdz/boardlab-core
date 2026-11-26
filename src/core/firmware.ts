/**
 * The firmware boardd can load: files a *release* ships in `firmware/firmware.json`, and files a *module* adds at
 * start, each listed with the sha256 it must still have.
 *
 * A vendor's firmware is not every vendor's: a distribution that has none still boots and flashes with the SDK, and a
 * module that brings its own (a market's, on the machines that need it) adds it without touching the core. Both are
 * the same shape, so `stage`, `boot` and `firmware` do not know which one an image came from.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Firmware } from '../shared/types.ts'
import { BoardError } from './errors.ts'

export function readFirmware(dir: string | undefined): Firmware[] {
  if (!dir) return []
  const manifest = join(dir, 'firmware.json')
  let raw: unknown
  try { raw = JSON.parse(readFileSync(manifest, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`读不懂 ${manifest}：${(error as Error).message}`)
  }
  if (!Array.isArray(raw)) throw new Error(`${manifest} 应该是一个数组`)
  return raw.map((entry, index) => {
    const field = (name: string) => {
      const value = (entry as Record<string, unknown>)?.[name]
      if (typeof value !== 'string' || !value) throw new Error(`${manifest} 第 ${index + 1} 条缺少 ${name}`)
      return value
    }
    const note = (entry as Record<string, unknown>)?.note
    return { soc: field('soc'), purpose: field('purpose'), path: resolve(dir, field('file')), sha256: field('sha256'), note: typeof note === 'string' ? note : null }
  })
}

/** Everything a lab can load: a release's own files, then what its modules added (a module's win a duplicate). */
export function firmwareOf(dir: string | undefined, added: Firmware[]): Firmware[] {
  const merged = new Map<string, Firmware>()
  for (const item of [...readFirmware(dir), ...added]) merged.set(`${item.soc}/${item.purpose}`, item)
  return [...merged.values()]
}

/** A firmware file by purpose, for the board's SoC when it is known, whose content still matches its manifest. */
export function verifiedFirmware(all: Firmware[], purpose: string, soc: string | null): Firmware {
  const matches = all.filter(item => item.purpose === purpose && (!soc || item.soc === soc))
  if (!matches.length) throw new BoardError('not-found', `boardd 没有可加载的${soc ? ` ${soc} ` : ''}固件 ${purpose}（自带的在 firmware/firmware.json，模块带来的在它自己的设置里）`)
  if (matches.length > 1) throw new BoardError('invalid', `有多个 SoC 的固件叫 ${purpose}，这块板的 SoC 未知`)
  const image = matches[0]!
  let actual: string
  try { actual = createHash('sha256').update(readFileSync(image.path)).digest('hex') }
  catch { throw new BoardError('invalid', `固件文件不可读：${image.path}`) }
  if (actual !== image.sha256) throw new BoardError('invalid', `固件 ${image.path} 的 sha256 与它的清单不符，拒绝加载`)
  return image
}
