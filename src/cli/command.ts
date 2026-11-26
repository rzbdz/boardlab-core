/**
 * What a `boardlab` command is, and what it gets to run with. Commands come from the core (boards, labs, setup) and
 * from a distribution's modules (`src/modules/<id>/cli.ts`), which contribute the commands for what they bring.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BoardsClient } from '../shared/client.ts'
import type { Command as SharedCommand, CommandGroup as SharedCommandGroup, RemoteContext } from '../shared/commands.ts'
import type { Board, Chip, State } from '../shared/types.ts'
import type { CatalogEntry } from '../server/catalog.ts'

// Asking a person and writing back are generic terminal work, in `shared` so a module's command gets them too.
export { confirm, write } from '../shared/terminal.ts'


/** Pure presentation supplied by a distribution; it cannot perform I/O or mutate board state. */
export interface CliPresentation {
  boardPlace?(board: Board): string
  boardDetails?(board: Board): string
  chipDetails?(board: Board, chip: Chip): string
  emptyPlaces?(state: State): string[]
  stateDetails?(state: State): string | null
  lockTokenHint?(gateToken: string): string | null
}

export interface CommandContext extends RemoteContext {
  /** The distribution's modules, for running boardd (`serve`). */
  catalog: CatalogEntry[]
}

// A command's shape is the same for this build's CLI and a module's own (`../shared/commands.ts`); here its `run` is
// handed this build's `CommandContext`.
export interface Command extends Omit<SharedCommand, 'run'> { run(context: CommandContext): Promise<void> | void }
export type CommandGroup = Omit<SharedCommandGroup, 'commands'> & { commands: Command[] }

/**
 * Run a long operation on boardd (a boot, a flash, a discovery) that `target` names for `boardlab cancel`. Ctrl-C asks
 * nothing: this CLI stops following, and the operation goes on in boardd, so a board half written is never left by a
 * keystroke; it prints how to stop it. With `cancelOnInterrupt` Ctrl-C cancels it instead and waits for it to end.
 */
export async function following<T>(client: BoardsClient, target: string, run: () => Promise<T>, options: { cancelOnInterrupt?: boolean, token?: string | null } = {}): Promise<T> {
  let interrupted = false
  const onInterrupt = () => {
    if (options.cancelOnInterrupt && !interrupted) {
      interrupted = true
      console.error(`\n正在取消 ${target}（再按一次 Ctrl-C 不再等它）…`)
      void client.cancel(target, options.token).then(result => console.error(result.message), error => console.error(`没能取消：${(error as Error).message}`))
      return
    }
    console.error(`\n不再跟着看了；${target} 上的操作在 boardd 里继续。要停下它：boardlab cancel ${target}`)
    process.exit(130)
  }
  process.on('SIGINT', onInterrupt)
  try { return await run() } finally { process.off('SIGINT', onInterrupt) }
}

export const splitTarget = (target: string) => { const [board, die] = target.split('.', 2) as [string, string | undefined]; return { board, die } }

export { parseDuration } from '../shared/duration.ts'

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

