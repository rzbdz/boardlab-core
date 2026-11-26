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
  /** The module's own code; boardd runs it in its CLI process, with `ctx` the same context a built-in command gets. */
  run(context: unknown): Promise<void> | void
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
