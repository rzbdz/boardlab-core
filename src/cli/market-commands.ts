/**
 * A market's commands, as this CLI runs them.
 *
 * A module that lives in a market brings its own `boardlab` commands, and they are the module's code: they belong to
 * the boardd that loaded it, not to this CLI's build. So a market is asked what it offers (`GET /api/cli`), and a
 * command from one is run by that boardd (the same `POST /api/cli` an older CLI's unknown commands take): the module is
 * loaded there, with the SDK it was written against, and the CLI only renders what comes back.
 *
 * A command here is a description — its group, what it does, how it is run — built from the markets' manifests. A
 * command a market *describes* as `standalone` (it changes this machine: installing a CLI) is refused rather than run
 * on a boardd somewhere else.
 *
 * Nothing in this file knows a module's name: a market says what it has, and this turns that into commands.
 */
import type { BoardsClient } from '../shared/client.ts'
import type { Command, CommandContext, CommandGroup } from './command.ts'

/** One command a market offers, as its manifest or its module describes it. */
export interface MarketCommand {
  name: string
  usage: string[]
  /** The heading it appears under, and that heading's one line (`boardlab help` shows it once). */
  group: { id: string, title: string, summary?: string }
  /** It changes this machine rather than the lab: only a CLI on this machine may run it. */
  standalone?: boolean
  noBoard?: boolean
}

/** What a market answers for `GET /api/cli`: every command the modules it loaded bring. */
export interface MarketCommands { commands: MarketCommand[] }

/**
 * A command a market offers: run by the boardd that has the module, as typed (the module parses its own flags as its
 * own `cli.ts` did), and its output comes back here line by line.
 */
function marketCommand(described: MarketCommand, client: () => BoardsClient): Command {
  return {
    name: described.name,
    usage: described.usage,
    ...(described.standalone ? { standalone: true } : {}),
    ...(described.noBoard ? { noBoard: true } : {}),
    async run(context: CommandContext) {
      const result = await client().proxy([described.name, ...context.argv], context.json, (stream, text) => {
        (stream === 'stdout' ? process.stdout : process.stderr).write(text)
      })
      process.exitCode = result.code
    },
  }
}

/**
 * The groups for a market's commands, on top of the ones this build has: a command the build already has keeps it (a
 * market cannot replace `boardlab lock`), and two markets offering the same name is an error to settle rather than a
 * silent winner.
 */
export function withMarketCommands(groups: CommandGroup[], offered: MarketCommand[], client: () => BoardsClient): CommandGroup[] {
  const known = new Set(groups.flatMap(group => group.commands.map(command => command.name)))
  const seen = new Set<string>()
  const added = new Map<string, CommandGroup>()
  for (const described of offered) {
    if (known.has(described.name)) continue
    if (seen.has(described.name)) throw new Error(`两个模块市场都提供 boardlab ${described.name}：只留一个`)
    seen.add(described.name)
    const group = added.get(described.group.id) ?? { id: described.group.id, title: described.group.title, summary: described.group.summary, commands: [] }
    group.commands.push(marketCommand(described, client))
    added.set(described.group.id, group)
  }
  return [...groups, ...added.values()]
}

/** Ask a boardd which commands its markets' modules bring; a boardd that cannot say offers none. */
export async function marketCommands(client: BoardsClient): Promise<MarketCommand[]> {
  try { return (await client.call<MarketCommands>('GET', '/api/cli/commands')).commands ?? [] }
  catch { return [] }
}
