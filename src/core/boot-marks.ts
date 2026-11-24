/**
 * Where a board boots in its console log: lines that open a stage of a boot (a firmware's first line, a kernel's
 * banner), so a page can mark every boot and go to one. The core ships the banners of the common open boot stages; a
 * backend adds the lines its own boards print (`SerialCapability.bootMarks`): above all its SoC's boot ROM, which only
 * the backend knows, and a kernel or loader of its own.
 *
 * A pattern is a regular expression in the part JavaScript and Python share (no lookbehind, no named groups), so a
 * backend that reads its own logs can run the same patterns where the log is.
 */

import type { BootLine, BootMark } from '../shared/types.ts'
export type { BootLine, BootMark }

/**
 * The banners every common open boot stage prints, as they print them. Each is anchored on the banner's own words
 * and a version, not on a whole line, so a stamp or a log prefix before it does not matter.
 */
export const BOOT_MARKS: readonly BootMark[] = [
  { id: 'spl', title: 'U-Boot SPL', pattern: 'U-Boot (?:SPL|TPL|VPL) \\d{4}\\.\\d{2}', stage: 1, tone: 'spl' },
  { id: 'edk2', title: 'EDK2', pattern: '(?:UEFI firmware \\(version|EDK II|Tianocore/EDK2|BdsDxe: loading Boot)', stage: 2, tone: 'firmware' },
  { id: 'opensbi', title: 'OpenSBI', pattern: '^\\s*(?:\\[[^\\]]*\\]\\s*)?OpenSBI v\\d+\\.\\d+', stage: 2, tone: 'firmware' },
  { id: 'uboot', title: 'U-Boot', pattern: 'U-Boot \\d{4}\\.\\d{2}(?:[-.\\w+]*)? \\(', stage: 3, tone: 'loader' },
  { id: 'linux', title: 'Linux', pattern: 'Linux version \\d+\\.\\d+[\\w.+~-]* \\(', stage: 4, tone: 'kernel' },
]

/** The marks to look for: the core's, then the backend's (one with a core mark's id takes its place). */
export function bootMarks(...sources: Array<readonly BootMark[] | null | undefined>): BootMark[] {
  const byId = new Map<string, BootMark>()
  for (const source of sources) for (const mark of source ?? []) byId.set(mark.id, mark)
  return [...byId.values()]
}

/** A mark that is not one: why, or null. Checked before a pattern reaches a backend or a page. */
export function badMark(mark: BootMark): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(mark.id)) return `启动标记的 id 不对：${mark.id}`
  if (typeof mark.pattern !== 'string' || !mark.pattern || mark.pattern.length > 400) return `启动标记 ${mark.id} 的 pattern 要写`
  if (/\(\?<|\(\?P/.test(mark.pattern)) return `启动标记 ${mark.id} 的 pattern 不能用回看和命名组`
  try { new RegExp(mark.pattern, mark.flags ?? '') } catch (error) { return `启动标记 ${mark.id} 的 pattern 不是合法的正则：${(error as Error).message}` }
  return null
}

/**
 * The boot lines among `lines` (numbered from `base`): one pass, one combined expression, each match taken by the
 * first mark that matches it. At most `max`.
 */
export function findBootLines(lines: { length: number, at(index: number): string }, base: number, marks: readonly BootMark[], max = 100_000, from = 0): { marks: BootLine[], marksTruncated: boolean } {
  const found: BootLine[] = []
  if (!marks.length) return { marks: found, marksTruncated: false }
  const plain = marks.filter(mark => mark.flags !== 'i'), blind = marks.filter(mark => mark.flags === 'i')
  const any = [plain, blind].map((group, index) => group.length ? new RegExp(group.map(mark => `(?:${mark.pattern})`).join('|'), index ? 'i' : '') : null)
  const each = marks.map(mark => new RegExp(mark.pattern, mark.flags ?? ''))
  let truncated = false
  for (let index = Math.max(0, from - base); index < lines.length; index++) {
    const line = lines.at(index)
    if (!any.some(rx => rx?.test(line))) continue
    // A line some mark matched: which one, in the order they are listed.
    const which = each.findIndex(rx => rx.test(line))
    if (found.length >= max) { truncated = true; break }
    found.push({ line: base + index, id: marks[which]!.id, text: line.slice(0, 200) })
  }
  return { marks: found, marksTruncated: truncated }
}
