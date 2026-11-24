/** A console's buffer read as a log: numbered lines kept in a ring, windows by number or position, and searches. */
import { describe, expect, it } from 'vitest'
import { readLog } from '../src/core/consoles.ts'
import { LineRing } from '../src/core/ring.ts'

describe('the line ring', () => {
  it('keeps the last lines, numbered from the first ever pushed', () => {
    const ring = new LineRing(3, ['a', 'b'])
    expect([ring.base, ring.length, ring.slice()]).toEqual([0, 2, ['a', 'b']])
    for (const line of ['c', 'd', 'e']) ring.push(line)
    expect([ring.base, ring.length, ring.slice()]).toEqual([2, 3, ['c', 'd', 'e']])
    expect([ring.get(1), ring.get(2), ring.get(4), ring.get(5)]).toEqual([undefined, 'c', 'e', undefined])
    expect(ring.slice(3, 9)).toEqual(['d', 'e'])
  })
})

describe('reading a log', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `[2026-11-10 08:00:0${i}] line ${i}${i % 3 === 0 ? ' ERROR' : ''}`)

  it('reads a window around a line by its number or position, and says whether the log goes on', () => {
    // Numbered from 100: the 100 lines before were dropped from the buffer.
    const middle = readLog(lines, 100, 'e1', { at: 'line:105', before: 2, after: 1 })
    expect(middle).toMatchObject({ lines: lines.slice(3, 7), numbers: [103, 104, 105, 106], at: 'be1:105', moreBefore: true, moreAfter: true, snapped: false, total: 10, base: 100 })
    expect(readLog(lines, 100, 'e1', { at: middle.positions![0], after: 0 })).toMatchObject({ lines: [lines[3]], at: 'be1:103' })
    expect(readLog(lines, 100, 'e1', { at: 'start', after: 2 })).toMatchObject({ numbers: [100, 101], moreBefore: false, moreAfter: true, at: null })
    expect(readLog(lines, 100, 'e1', { at: 'end', before: 3 })).toMatchObject({ numbers: [107, 108, 109], moreBefore: true, moreAfter: false })
    // A line dropped since, or past the end, or a position from a buffer gone since: the nearest line kept.
    expect(readLog(lines, 100, 'e1', { at: 'line:3' })).toMatchObject({ numbers: [100], snapped: true })
    expect(readLog(lines, 100, 'e1', { at: 'line:500' })).toMatchObject({ numbers: [109], snapped: true })
    expect(readLog(lines, 100, 'e1', { at: 'be0:105' })).toMatchObject({ snapped: true })
    expect(readLog([], 0, 'e1', { at: 'line:0', before: 5 })).toMatchObject({ lines: [], total: 0, moreBefore: false, moreAfter: false })
  })

  it('searches with each line numbered, or gives only where every match is', () => {
    expect(readLog(lines, 100, 'e1', { grep: 'error' })).toMatchObject({ numbers: [100, 103, 106, 109], matched: 4, positions: ['be1:100', 'be1:103', 'be1:106', 'be1:109'] })
    expect(readLog(lines, 100, 'e1', { grep: 'error', limit: 2 })).toMatchObject({ numbers: [106, 109], truncated: true })
    expect(readLog(lines, 100, 'e1', { grep: 'error', limit: 2, first: true })).toMatchObject({ numbers: [100, 103] })
    expect(readLog(lines, 100, 'e1', { grep: 'ERROR$', regex: true, hits: true })).toEqual({ lines: [], matched: 4, truncated: false, hits: [100, 103, 106, 109], hitsTruncated: false, total: 10, base: 100, positions: [], numbers: [] })
    expect(readLog(lines, 100, 'e1', { grep: 'error', hits: true, maxHits: 3 })).toMatchObject({ hits: [100, 103, 106], hitsTruncated: true, matched: 4 })
  })

  it('reads a window in time that does not grow with the log, and searches a big one in one pass', () => {
    const big = new LineRing(1_000_000)
    for (let i = 0; i < 1_200_000; i++) big.push(i % 1000 === 0 ? `line ${i} mark` : `line ${i}`)
    const log = { length: big.length, at: (index: number) => big.get(big.base + index)! }
    const time = (at: string) => { const start = performance.now(); for (let i = 0; i < 50; i++) readLog(log, big.base, 'e', { at, before: 100, after: 100 }); return (performance.now() - start) / 50 }
    // A window costs its own size: the same at the start, the middle and the end, and well under a millisecond or two.
    const [start, middle, end] = [time(`line:${big.base}`), time(`line:${big.base + 500_000}`), time(`line:${big.base + 999_999}`)]
    expect(Math.max(start, middle, end)).toBeLessThan(5)
    expect(readLog(log, big.base, 'e', { at: `line:${big.base + 500_000}`, before: 1, after: 1 }).lines).toEqual(['line 699999', 'line 700000 mark', 'line 700001'])
    const t0 = performance.now()
    const found = readLog(log, big.base, 'e', { grep: 'mark', hits: true })
    expect(performance.now() - t0).toBeLessThan(1500)
    expect([found.matched, found.hits![0], found.hits!.at(-1)]).toEqual([1000, 200_000, 1_199_000])
  })
})
