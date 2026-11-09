/** The firmware boardd ships: firmware/firmware.json lists each file with the sha256 it must still have. */
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

/** A firmware file by purpose, for the board's SoC when it is known, whose content still matches firmware.json. */
export function verifiedFirmware(dir: string | undefined, purpose: string, soc: string | null): Firmware {
  const matches = readFirmware(dir).filter(item => item.purpose === purpose && (!soc || item.soc === soc))
  if (!matches.length) throw new BoardError('not-found', `boardd 没有自带${soc ? ` ${soc} 的` : ''}固件 ${purpose}（见仓库的 firmware/firmware.json）`)
  if (matches.length > 1) throw new BoardError('invalid', `有多个 SoC 的固件叫 ${purpose}，这块板的 SoC 未知`)
  const image = matches[0]!
  let actual: string
  try { actual = createHash('sha256').update(readFileSync(image.path)).digest('hex') }
  catch { throw new BoardError('invalid', `固件文件不可读：${image.path}`) }
  if (actual !== image.sha256) throw new BoardError('invalid', `固件 ${image.path} 的 sha256 与 firmware.json 不符，拒绝加载`)
  return image
}
