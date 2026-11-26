/**
 * What a `boardlab` command is, as a module that is not part of this build may bring one.
 *
 * A command's `run` is code, and where it runs decides what it may use. Two kinds:
 *
 * - **listed**: a command this build's CLI has, whose `run` talks to boardd through the client it is given. A module in
 *   a market cannot add one of these to a CLI built without it — so its commands are `remote`.
 * - **remote**: a command whose `run` is the module's own, and therefore executes in the boardd that loaded the module
 *   (its `cli` file, run by `POST /api/cli`). The CLI only knows how to list it and where to send it, which is this
 *   interface: no `CommandContext`, no client, nothing of this build.
 *
 * A module's `cli.ts` exports a `RemoteCommandGroup`; this distribution's own modules export a `CommandGroup`
 * (`./command.ts`, whose commands are `listed`).
 */
import type { BoardsClient } from './client.ts'

/**
 * What a command's `run` is handed. The CLI's own commands get more (`CatalogEntry`s, for running boardd), but this is
 * what a command in a market may rely on: it is the same context, described from the other side of the seam.
 */
/**
 * A command's shape, wherever it is written: a distribution's own module and one from a market both declare their
 * commands this way. `run` is the command; what it is handed is `CommandContext` (`../cli/command.ts`) for a listed
 * command and `RemoteContext` below for one a market brings.
 */
export interface Command {
  name: string
  /** Lines for `boardlab help`, each `<synopsis>` or `<synopsis>\t<what it does>`. */
  usage: string[]
  /** Runs without reaching boardd (installing, choosing a boardd, running one). */
  standalone?: boolean
  /** Its first argument is not a board (it hands its arguments on, or names a lab), so a slot reference there is left alone. */
  noBoard?: boolean
  run(context: RemoteContext): Promise<void> | void
}

/**
 * Commands under one heading of `boardlab help`: `id` names the group for `boardlab help <id>`, `summary` is its line in
 * the overview.
 */
export interface CommandGroup { title: string, commands: Command[], id?: string, summary?: string }

export interface RemoteContext {
  /** What followed the command name: positional words, and every raw argument (for commands that pass them on). */
  args: string[]
  argv: string[]
  flags: Map<string, string | true>
  flag(name: string): string | undefined
  json: boolean
  /** Print `value` as JSON with --json, else run `text`. */
  out(value: unknown, text: () => void): void
  stateDir: string
  /** boardd, and who this CLI acts as there. */
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

/** A command that runs where its module is loaded (a market module's own). */
export interface RemoteCommand {
  name: string
  /** Lines for `boardlab help`, each `<synopsis>` or `<synopsis>\t<what it does>`. */
  usage: string[]
  /**
   * It changes this machine rather than the lab (installing a CLI, a key): only a CLI on this machine may run it, never
   * by forwarding it to a boardd somewhere else.
   */
  standalone?: boolean
  /** Its first argument is not a board (it names a lab, or hands its arguments on), so a slot reference is left alone. */
  noBoard?: boolean
  /** The module's own code; boardd runs it in its CLI process, with a context of the same shape a built-in command gets. */
  run(context: RemoteContext): Promise<void> | void
}

/** Commands under one heading of `boardlab help`, as a module in a market exports them. */
export interface RemoteCommandGroup { title: string, commands: RemoteCommand[], id?: string, summary?: string }

/**
 * Whether what a file exported is such a group. Checked rather than trusted: a market's file is a foreign package, and
 * one that gets the shape wrong is reported to the person who installed it, not thrown at them as a crash.
 */
export const isRemoteGroup = (value: unknown): value is RemoteCommandGroup => {
  const group = value as RemoteCommandGroup | undefined
  return !!group && typeof group === 'object' && typeof group.title === 'string' && Array.isArray(group.commands)
    && group.commands.every(command => !!command && typeof command.name === 'string' && typeof command.run === 'function' && Array.isArray(command.usage))
}
