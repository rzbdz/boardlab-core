/**
 * A market module's own `boardlab` commands, loaded where the module is.
 *
 * A module that lives in a market carries its commands as its own code (`cli.ts`, the same `CommandGroup` a built-in
 * module's `cli.ts` exports). They cannot be built into this distribution's CLI — that build has no module — so the
 * boardd that loaded the module loads that file and *describes* the commands to a CLI: its name, its synopsis lines and
 * its heading. Running one is `POST /api/cli`, which boardd runs against this same CLI with the module's commands
 * registered (see `withCommands`): the module's `run` executes here, with the module's own SDK.
 *
 * `run` is the module's function, called where it lives; this file only supplies it to the CLI process's command map,
 * so a module needs nothing but what its own file imports (the SDK it was written against).
 */
import { delimiter } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Command, CommandGroup } from './command.ts'

export type { Command, CommandGroup }

/** One command of a module, as a CLI that does not have the module can list and check it. */
export interface DescribedCommand {
  name: string
  usage: string[]
  group: { id: string, title: string, summary?: string }
  standalone?: boolean
  noBoard?: boolean
}

/** What a market module's `cli.ts` exports: the same group a built-in module's `cli.ts` exports. */
const isGroup = (value: unknown): value is CommandGroup => {
  const group = value as CommandGroup | undefined
  return !!group && typeof group === 'object' && typeof group.title === 'string' && Array.isArray(group.commands)
    && group.commands.every(command => !!command && typeof command.name === 'string' && typeof command.run === 'function' && Array.isArray(command.usage))
}

/**
 * The commands one module's `cli` file exports, or a problem saying why it has none.
 *
 * `id` is the group's default id (the module's): a group that names one keeps it, so a module may put its commands
 * under a heading other than its own name.
 */
export async function loadCommands(file: string, id: string): Promise<{ group: CommandGroup | null, problem: string | null }> {
  let loaded: Record<string, unknown>
  try { loaded = await import(pathToFileURL(file).href) as Record<string, unknown> }
  catch (error) { return { group: null, problem: `命令文件 ${file} 加载不了：${(error as Error).message}` } }
  const exported = loaded.commands ?? loaded.default ?? loaded[id]
  if (!isGroup(exported)) return { group: null, problem: `命令文件 ${file} 没有导出 commands（一个 {title, commands} 组）` }
  return { group: { ...exported, id: exported.id ?? id }, problem: null }
}

/** A group's commands as a CLI lists them, with the group they belong to. */
export function describe(group: CommandGroup): DescribedCommand[] {
  return group.commands.map(command => ({
    name: command.name,
    usage: command.usage,
    group: { id: group.id ?? 'module', title: group.title, ...(group.summary ? { summary: group.summary } : {}) },
    ...(command.standalone ? { standalone: true } : {}),
    ...(command.noBoard ? { noBoard: true } : {}),
  }))
}

/**
 * The commands of the modules a boardd loaded from markets, for the CLI process boardd starts for a client: the
 * variable names each module's `cli` file as `id=path`, and every one is imported here (the module's code runs in this
 * process, with the same SDK boardd loaded it with).
 */
export async function withMarketCli(spec: string): Promise<Array<{ name: string, command: Command }>> {
  const out: Array<{ name: string, command: Command }> = []
  for (const item of spec.split(delimiter)) {
    const at = item.indexOf('=')
    if (at <= 0) continue
    const { group, problem } = await loadCommands(item.slice(at + 1), item.slice(0, at))
    if (problem) { console.error(`boardlab：${problem}`); continue }
    for (const command of group!.commands) out.push({ name: command.name, command })
  }
  return out
}
