/**
 * The last `capacity` lines of a stream, numbered from the first ever pushed: adding a line is O(1), and so is reading
 * one by its number, so a console's buffer never copies itself as output arrives or as a part of it is read.
 */
export class LineRing {
  private readonly slots: string[]
  private head = 0
  private count = 0
  /** How many lines were pushed in all: the next line's number. */
  private pushed = 0

  constructor(readonly capacity: number, lines: string[] = []) {
    this.slots = new Array(Math.max(1, capacity))
    for (const line of lines.slice(-this.slots.length)) this.push(line)
  }

  push(line: string): void {
    const size = this.slots.length
    if (this.count < size) { this.slots[(this.head + this.count) % size] = line; this.count++ }
    else { this.slots[this.head] = line; this.head = (this.head + 1) % size }
    this.pushed++
  }

  /** How many lines it holds now. */
  get length(): number { return this.count }
  /** The number of the oldest line it holds. */
  get base(): number { return this.pushed - this.count }

  /** The line numbered `number`, or undefined when it is not held (gone, or not yet pushed). */
  get(number: number): string | undefined {
    const index = number - this.base
    if (index < 0 || index >= this.count) return undefined
    return this.slots[(this.head + index) % this.slots.length]
  }

  /** The lines numbered `from` up to `to` (not included), as far as it holds them. */
  slice(from = this.base, to = this.pushed): string[] {
    const lo = Math.max(from, this.base), hi = Math.min(to, this.pushed)
    const out: string[] = []
    for (let number = lo; number < hi; number++) out.push(this.get(number)!)
    return out
  }
}
