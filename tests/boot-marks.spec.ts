/** The lines that open a boot: the core's banners, a backend's own, and finding them in a log in one pass. */
import { describe, expect, it } from 'vitest'
import { BOOT_MARKS, badMark, bootMarks, findBootLines } from '../src/core/boot-marks.ts'
import { readLog } from '../src/core/consoles.ts'

const boot = (stamp: string) => [
  `[${stamp}] U-Boot SPL 2022.10-dirty (Nov 10 2026 - 08:00:00 +0800)`,
  `[${stamp}] DDR init ok`,
  `[${stamp}] OpenSBI v1.3`,
  `[${stamp}] U-Boot 2022.10-dirty (Nov 10 2026 - 08:00:00 +0800)`,
  `[${stamp}] Hit any key to stop autoboot:  0`,
  `[${stamp}] [    0.000000] Linux version 6.6.36 (builder@host) (gcc 13.2) #1 SMP`,
  `[${stamp}] login:`,
]
const list = (lines: string[]) => ({ length: lines.length, at: (index: number) => lines[index]! })

describe('boot marks', () => {
  it('knows the banners of the common open boot stages, and not lines that only talk about them', () => {
    const hit = (line: string) => findBootLines(list([line]), 0, BOOT_MARKS).marks[0]?.id ?? null
    expect(hit('U-Boot SPL 2022.10-dirty (Nov 10 2026 - 08:00:00 +0800)')).toBe('spl')
    expect(hit('U-Boot TPL 2024.01 (Jan 01 2024 - 00:00:00 +0000)')).toBe('spl')
    expect(hit('U-Boot 2022.10-dirty (Nov 10 2026 - 08:00:00 +0800)')).toBe('uboot')
    expect(hit('U-Boot 2024.07-rc3+ (Jul 01 2024 - 00:00:00 +0000)')).toBe('uboot')
    expect(hit('OpenSBI v1.3')).toBe('opensbi')
    expect(hit('[    0.000000] Linux version 6.18.0-12-generic (buildd@lcy02) (gcc 14.2.0) #12-Ubuntu SMP')).toBe('linux')
    expect(hit('UEFI firmware (version 1.0 built at 08:00:00 on Nov 10 2026)')).toBe('edk2')
    expect(hit('BdsDxe: loading Boot0001 "UEFI Shell" from Fv(...)')).toBe('edk2')
    for (const line of ['=> printenv bootcmd', 'echo U-Boot is here', 'grep "Linux version" /proc/version', 'cat /proc/version', 'opensbi is not here']) expect(hit(line)).toBeNull()
  })

  it('takes a backend\'s own marks, one with a core mark\'s id in its place, and refuses ones that are not marks', () => {
    const own = [{ id: 'linux', title: 'Linux', pattern: 'Linux version 6\\.18', stage: 4, tone: 'kernel' as const }, { id: 'rom', title: 'Boot ROM', pattern: 'BootROM v\\d', flags: 'i' as const, stage: 0, tone: 'rom' as const }]
    const marks = bootMarks(BOOT_MARKS, own)
    expect(marks.find(mark => mark.id === 'linux')!.pattern).toBe('Linux version 6\\.18')
    expect(marks.map(mark => mark.id)).toEqual(['spl', 'edk2', 'opensbi', 'uboot', 'linux', 'rom'])
    expect(findBootLines(list(['bootrom V2 starting']), 0, marks).marks).toEqual([{ line: 0, id: 'rom', text: 'bootrom V2 starting' }])
    expect(badMark({ id: 'x', title: '', pattern: '(', stage: 0, tone: 'rom' })).toMatch(/不是合法的正则/)
    expect(badMark({ id: 'x', title: '', pattern: '(?<=a)b', stage: 0, tone: 'rom' })).toMatch(/回看/)
    expect(badMark({ id: 'X Y', title: '', pattern: 'a', stage: 0, tone: 'rom' })).toMatch(/id/)
    for (const mark of BOOT_MARKS) expect(badMark(mark)).toBeNull()
  })

  it('finds every boot in a log, numbered, from a line on, alone or with a search', () => {
    const lines = [...boot('2026-11-10 08:00:00'), 'noise', ...boot('2026-11-10 09:00:00')]
    const found = readLog(lines, 10, 'e', { marks: [...BOOT_MARKS] })
    expect(found.marks!.map(mark => [mark.line, mark.id])).toEqual([[10, 'spl'], [12, 'opensbi'], [13, 'uboot'], [15, 'linux'], [18, 'spl'], [20, 'opensbi'], [21, 'uboot'], [23, 'linux']])
    expect(found).toMatchObject({ lines: [], total: 15, marksTruncated: false })
    // The line a mark names is the line a window there shows.
    expect(readLog(lines, 10, 'e', { at: `line:${found.marks![3]!.line}` }).lines[0]).toContain('Linux version')
    expect(readLog(lines, 10, 'e', { marks: [...BOOT_MARKS], fromLine: 17 }).marks!.map(mark => mark.line)).toEqual([18, 20, 21, 23])
    expect(readLog(lines, 10, 'e', { marks: [...BOOT_MARKS], grep: 'login', hits: true })).toMatchObject({ hits: [16, 24], marks: expect.arrayContaining([expect.objectContaining({ line: 23 })]) })
    expect(readLog(lines, 10, 'e', { marks: [...BOOT_MARKS], maxMarks: 3 })).toMatchObject({ marksTruncated: true, marks: [{ line: 10 }, { line: 12 }, { line: 13 }] })
  })

  it('finds the boots in a million lines in one pass', () => {
    const lines: string[] = []
    for (let i = 0; i < 1_000_000; i++) lines.push(i % 50_000 === 0 ? `[    0.000000] Linux version 6.6.${i} (b@h) (gcc) #1` : `[  ${i}.000000] some driver said something`)
    const start = performance.now()
    const found = findBootLines(list(lines), 0, BOOT_MARKS)
    expect(performance.now() - start).toBeLessThan(2000)
    expect(found.marks.map(mark => mark.line)).toEqual(Array.from({ length: 20 }, (_, i) => i * 50_000))
  })
})
