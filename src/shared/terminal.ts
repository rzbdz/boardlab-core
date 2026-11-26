/**
 * Talking to the person at a terminal from a `boardlab` command: asking yes or no, and writing a streamed answer back
 * where it came from. In `shared` because a module's own command (from a distribution or a market) does the same, and
 * the SDK hands it out.
 */
import { createInterface } from 'node:readline/promises'

/** Ask on the terminal; without one the answer is no. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question} [y/N] `)
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

/** Write a streamed command's output where it came from. */
export const write = (stream: 'stdout' | 'stderr', text: string) => { (stream === 'stdout' ? process.stdout : process.stderr).write(text) }
