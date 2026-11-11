/**
 * What a `boardlab` command is, and what it gets to run with. Commands come from the core (boards, labs, setup) and
 * from a distribution's modules (`src/modules/<id>/cli.ts`), which contribute the commands for what they bring.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { BoardsClient } from '../shared/client.ts'
import type { CatalogEntry } from '../server/catalog.ts'

export interface Command {
  name: string
  /** Lines for `boardlab help`, each `<synopsis>` or `<synopsis>\t<what it does>`. */
  usage: string[]
  /** Runs without reaching boardd (installing, choosing a boardd, running one). */
  standalone?: boolean
  /** Its first argument is not a board (it hands its arguments on, or names a lab), so a slot reference there is left alone. */
  noBoard?: boolean
  run(context: CommandContext): Promise<void> | void
}

/**
 * Commands under one heading of `boardlab help`: `id` names the group for `boardlab help <id>`, `summary` is its line in
 * the overview.
 */
export interface CommandGroup { title: string, commands: Command[], id?: string, summary?: string }

export interface CommandContext {
  /** What followed the command name: positional words, and every raw argument (for commands that pass them on). */
  args: string[]
  argv: string[]
  flags: Map<string, string | true>
  flag(name: string): string | undefined
  json: boolean
  /** Print `value` as JSON with --json, else run `text`. */
  out(value: unknown, text: () => void): void
  stateDir: string
  /** The distribution's modules, for running boardd (`serve`). */
  catalog: CatalogEntry[]
  /** boardd, and who this CLI acts as there. Not set for standalone commands. */
  client: BoardsClient
  holder: string
  /** boardd is on another machine (its files are not this machine's). */
  remote: boolean
  /** The board (and chip) named first: `<board>[.<die>]`. */
  target(): { board: string, die: string | undefined }
  /** The lock token this CLI holds for a board, if any, and keeping or forgetting one. */
  token(board?: string): string | null
  keepToken(board: string, token: string | null): void
}

export const splitTarget = (target: string) => { const [board, die] = target.split('.', 2) as [string, string | undefined]; return { board, die } }

export function parseDuration(text: string): number {
  const match = text.match(/^(\d+)(s|m|h)?$/)
  if (!match) throw new Error(`时长格式不对：${text}（例如 30m、2h、90s）`)
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? 'm') as 's' | 'm' | 'h']
}

/** Lock tokens this user's CLI obtained, so later commands of the same holder can prove the lock. */
export class TokenStore {
  constructor(private readonly file: string) {}
  private read(): Record<string, string> { try { return JSON.parse(readFileSync(this.file, 'utf8')) } catch { return {} } }
  private write(data: Record<string, string>) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 })
    chmodSync(this.file, 0o600)
  }
  get(holder: string, board: string) { return this.read()[`${holder} ${board}`] ?? null }
  set(holder: string, board: string, token: string | null) {
    const data = this.read()
    if (token) data[`${holder} ${board}`] = token; else delete data[`${holder} ${board}`]
    this.write(data)
  }
}

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
