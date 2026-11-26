/**
 * A market module's own `boardlab` commands, loaded where the module is.
 *
 * A module that lives in a market carries its commands as its own code (`cli.ts`, exporting a `RemoteCommandGroup`,
 * see `shared/commands.ts`). They cannot be built into a distribution's CLI — that build has no module — so the boardd
 * that loaded the module loads that file too and *describes* the commands to a CLI that asks (name, synopsis lines,
 * heading). Running one is `POST /api/cli`: boardd starts this same CLI with the module's files named in
 * `BOARDLAB_MARKET_CLI`, and there the module's `run` executes, in a process that has the module.
 *
 * This file is the seam: boardd may load it (the only `cli/` file it imports), and it imports nothing from the CLI
 * build's context or client, so a module's command never depends on which CLI started it.
 */
import { delimiter } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isRemoteGroup, type RemoteCommandGroup } from '../shared/commands.ts'
import { resolveBoardlab } from '../shared/sdk-resolve.ts'

/** One command of a module, as a CLI that does not have the module can list and check it. */
export interface DescribedCommand {
  name: string
  usage: string[]
  group: { id: string, title: string, summary?: string }
  standalone?: boolean
  noBoard?: boolean
}

/**
 * The commands one module's `cli` file exports, or a problem saying why it has none. `id` is the group's default id
 * (the module's): a group that names one keeps it, so a module may put its commands under a heading of its own.
 */
export async function loadCommands(file: string, id: string): Promise<{ group: RemoteCommandGroup | null, problem: string | null }> {
  let loaded: Record<string, unknown>
  try { loaded = await import(pathToFileURL(file).href) as Record<string, unknown> }
  catch (error) { return { group: null, problem: `命令文件 ${file} 加载不了：${(error as Error).message}` } }
  const exported = loaded.commands ?? loaded.default ?? loaded[id]
  if (!isRemoteGroup(exported)) return { group: null, problem: `命令文件 ${file} 没有导出 commands（一个 {title, commands} 组）` }
  return { group: { ...exported, id: exported.id ?? id }, problem: null }
}

/** A group's commands as a CLI lists them, with the group they belong to. */
export function describe(group: RemoteCommandGroup): DescribedCommand[] {
  return group.commands.map(command => ({
    name: command.name,
    usage: command.usage,
    group: { id: group.id ?? 'module', title: group.title, ...(group.summary ? { summary: group.summary } : {}) },
    ...(command.standalone ? { standalone: true } : {}),
    ...(command.noBoard ? { noBoard: true } : {}),
  }))
}

/** One market command, as the CLI process boardd starts registers it: its `run`, and the heading it belongs to. */
export interface RegisteredCommand { name: string, run: RemoteCommandGroup['commands'][number]['run'], group: RemoteCommandGroup }

/**
 * The commands of the modules a boardd loaded from markets, for the CLI process boardd starts for a client: the
 * variable names each module's `cli` file as `id=path`, and each is imported here, so the module's `run` is registered
 * in that process and executes there, with the same SDK boardd loaded it with.
 */
export async function withMarketCli(spec: string): Promise<RegisteredCommand[]> {
  const out: RegisteredCommand[] = []
  // A module's `cli.ts` imports `boardlab` like its `index.ts` does: this process must resolve that name before the
  // first one loads. `BOARDLAB_SDK` is the SDK beside the CLI boardd started (see http.ts).
  if (process.env.BOARDLAB_SDK) resolveBoardlab(pathToFileURL(process.env.BOARDLAB_SDK).href)
  for (const item of spec.split(delimiter)) {
    const at = item.indexOf('=')
    if (at <= 0) continue
    const { group, problem } = await loadCommands(item.slice(at + 1), item.slice(0, at))
    if (problem) { console.error(`boardlab：${problem}`); continue }
    for (const command of group!.commands) out.push({ name: command.name, run: command.run, group: group! })
  }
  return out
}
