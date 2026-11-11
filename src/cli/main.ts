/**
 * The boardlab CLI. It talks to boardd over its Unix socket, or to a boardd elsewhere (`boardlab remote`); `boardlab
 * serve` runs boardd itself. A distribution makes its CLI with `createCli`: the core's commands (boards, labs, setup)
 * and the command groups its modules add. A command this CLI does not know is run by a remote boardd's own CLI, so
 * new commands reach old clients.
 */
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BoardsApiError, BoardsClient, defaultStateDir, defaultTransport, remoteConfigPath, socketPathFor, unixTransport } from '../shared/client.ts'
import type { CatalogEntry } from '../server/catalog.ts'
import { splitTarget, TokenStore, write, type Command, type CommandContext, type CommandGroup } from './command.ts'
import { boardCommands } from './commands/boards.ts'
import { labCommands } from './commands/labs.ts'
import { setupCommands } from './commands/setup.ts'

export { consoleKeys } from './console.ts'

/** A slot reference: `<host>/s3`, `<lab>/<host>/s3`, or `slot:5` on boardd's own machine. */
const SLOT_REF = /^(?:[A-Za-z0-9_.-]+\/){1,2}s\d+(?:\.die\d+)?$|^slot:\d+$/

/** Terminal cells a string takes: CJK and fullwidth characters take two. */
const cells = (text: string) => [...text].reduce((sum, char) => sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1), 0)

/** A group's usage lines, aligned. */
function linesOf(group: CommandGroup): string[] {
  const width = 37
  return group.commands.flatMap(command => command.usage.map(line => {
    const [synopsis, about] = line.split('\t') as [string, string | undefined]
    if (!about) return `  ${synopsis}`
    return cells(synopsis) < width ? `  ${synopsis}${' '.repeat(width - cells(synopsis))}${about}` : `  ${synopsis}\n  ${' '.repeat(width)}${about}`
  }))
}
const groupId = (group: CommandGroup) => group.id ?? group.commands[0]?.name ?? group.title
const FOOT = '持有人默认是 user:$USER；agent 用 --as claude:<会话> 或环境变量 BOARDS_HOLDER。'

/**
 * `boardlab help`: the everyday commands and one line per group; `help <group>` a group's commands, `help <command>`
 * one command, `help --all` everything.
 */
function usageOf(groups: CommandGroup[], topic?: string): string {
  const head = '用法：boardlab <命令> [参数] [--json] [--as <持有人>]（boards 是它的别名）'
  if (topic === '--all' || topic === 'all') return `${head}\n\n${groups.map(group => [`${group.title}：`, ...linesOf(group)].join('\n')).join('\n\n')}\n\n${FOOT}`
  if (topic) {
    const group = groups.find(item => groupId(item) === topic || item.title === topic)
    if (group) return `${group.title}：\n${linesOf(group).join('\n')}`
    const command = groups.flatMap(item => item.commands).find(item => item.name === topic)
    if (command) return linesOf({ title: '', commands: [command] }).join('\n')
    return `没有这个命令或分组：${topic}\n\n${usageOf(groups)}`
  }
  const everyday = [
    ['status', '一眼看全：boardd、你是谁、板子和锁、实验室、有没有新版'],
    ['list', '板子、槽位和锁'],
    ['lock <板子> --for <用途>', '拿锁（--wait 排队等到）；用完 unlock <板子>'],
    ['console <板子>', '串口终端（Ctrl-A Ctrl-X 退出）'],
    ['reset <板子> | fastboot <板子>', '复位、进下载模式（要拿锁）'],
    ['boot <板子> --sdk <SDK>', '用 SDK 的产物内存启动（--method download 刷机）'],
  ]
  const width = 30
  const pad = (text: string) => `  ${text}${' '.repeat(Math.max(2, width - cells(text)))}`
  return [head, '', '常用：', ...everyday.map(([synopsis, about]) => `${pad(synopsis!)}${about}`), '',
    '全部命令，按分组（boardlab help <分组> 看这一组的用法）：',
    ...groups.map(group => `${pad(groupId(group))}${group.summary ?? group.title}：${group.commands.map(command => command.name).join(' ')}`),
    '', 'boardlab help <命令> 看一个命令；boardlab help --all 列出全部；boardlab version 看版本。', FOOT].join('\n')
}

interface Args { positional: string[], flags: Map<string, string | true> }

export function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  const booleans = new Set(['json', 'wait', 'yes', 'raw', 'all', 'confirm', 'token-stdin', 'password-stdin', 'help', 'human', 'agents', 'interactive', 'global', 'no-ui'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-i') { flags.set('interactive', true); continue }
    if (arg === '-g') { flags.set('global', true); continue }
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    // `lock --wait` is a switch; `send --wait <pattern>` takes the pattern.
    const isSwitch = booleans.has(name) && !(name === 'wait' && positional[0] === 'send')
    if (inline !== undefined) flags.set(name, inline)
    else if (isSwitch || i + 1 >= argv.length) flags.set(name, true)
    else flags.set(name, argv[++i]!)
  }
  return { positional, flags }
}

/** What a distribution brings to its CLI: its modules' command groups, and its module catalog (for `serve`). */
export interface Distribution {
  groups: CommandGroup[]
  catalog: CatalogEntry[]
}

export interface Cli {
  main(argv: string[]): Promise<void>
  usage(topic?: string): string
}

export function createCli(distribution: Distribution): Cli {
  const groups = [boardCommands, labCommands, ...distribution.groups, setupCommands]
  const commands = new Map<string, Command>(groups.flatMap(group => group.commands.map(command => [command.name, command] as const)))
  const usage = (topic?: string) => usageOf(groups, topic)
  return { usage, main: argv => run(argv, commands, usage, distribution) }
}

async function run(argv: string[], COMMANDS: Map<string, Command>, usage: (topic?: string) => string, distribution: Distribution) {
  const { positional, flags } = parseArgs(argv)
  const [name, ...args] = positional
  const json = flags.has('json')
  const flag = (key: string) => { const value = flags.get(key); return typeof value === 'string' ? value : undefined }
  const out = (value: unknown, text: () => void) => json ? console.log(JSON.stringify(value, null, 2)) : text()
  if (!name) return console.log(usage(flags.has('all') ? '--all' : undefined))
  const stateDir = resolve(flag('state-dir') ?? defaultStateDir())
  const command = COMMANDS.get(name)
  // What followed the command word, flags included, for commands that hand their arguments on.
  const rest = argv.slice(argv.indexOf(name) + 1)
  const base = { args, argv: rest, flags, flag, json, out, stateDir, catalog: distribution.catalog }
  const target = () => { if (!args[0]) throw new Error('缺少板名'); return splitTarget(args[0]) }
  if (command?.standalone) {
    const offline = () => { throw new Error(`boardlab ${name} 不连 boardd`) }
    return command.run({ ...base, get client(): BoardsClient { return offline() }, holder: '', remote: false, target, token: offline, keepToken: offline })
  }

  // Run by boardd for a client (BOARDS_PROXIED): always against that boardd's own socket.
  const transport = flag('state-dir') || process.env.BOARDS_PROXIED ? unixTransport(socketPathFor(stateDir)) : defaultTransport(socketPathFor(stateDir))
  // Through a remote boardd you are the person it knows you as (your login there).
  const holder = flag('as') ?? process.env.BOARDS_HOLDER ?? `user:${transport.person ?? process.env.USER ?? 'unknown'}`
  const client = new BoardsClient(transport, holder)
  const remote = !client.transport.label.startsWith('/')
  // A remote boardd's lock tokens are kept with this user's configuration, not in a state directory.
  const tokens = new TokenStore(remote ? join(dirname(remoteConfigPath()), 'tokens.json') : join(stateDir, 'cli-tokens.json'))
  const help = name === 'help' || flags.has('help')

  // A remote boardd may be newer than this CLI: its help, and any command this CLI does not know, come from it.
  if (remote && !process.env.BOARDS_PROXIED && (help || !command)) {
    const passed = argv.filter(arg => arg !== '--json' && !arg.startsWith('--as') && arg !== flag('as'))
    try {
      const result = await client.proxy(help ? ['help', ...(name === 'help' ? args : [name]), ...(flags.has('all') ? ['--all'] : [])] : passed, json, write)
      process.exitCode = result.code
      return
    } catch (error) {
      // An older boardd does not run commands for clients: fall back to what this CLI knows.
      if (!(error instanceof BoardsApiError && (error.status === 404 || error.status === 501))) throw error
    }
  }
  if (help) return console.log(usage(name === 'help' ? args[0] ?? (flags.has('all') ? '--all' : undefined) : name))
  if (!command) throw new Error(`未知命令：${name}（boardlab help 看有哪些）`)
  // A board named by its slot (`lab/host/s3`, `slot:5`) is the board in it: resolved once, so lock tokens stay keyed by name.
  let resolved: { board: string, die: string | undefined } | null = null
  if (args[0] && SLOT_REF.test(args[0]) && !command.noBoard) {
    const [, ref, die] = args[0].match(/^(.*?)(?:\.(die\d+))?$/)!
    resolved = { board: (await client.board(ref!)).board.name, die }
  }
  const named = resolved ? () => resolved! : target
  const context: CommandContext = {
    ...base, client, holder, remote, target: named,
    token: board => tokens.get(holder, board ?? named().board),
    keepToken: (board, token) => tokens.set(holder, board, token),
  }
  return command.run(context)
}

/** Run the CLI as the program, when `entry` (the distribution's entry module, `import.meta.url`) is what was run. */
export function runIfMain(cli: Cli, entry: string) {
  if (!process.argv[1] || realpathSync(process.argv[1]) !== realpathSync(fileURLToPath(entry))) return
  cli.main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof BoardsApiError || error instanceof Error ? error.message : String(error))
    process.exit(error instanceof BoardsApiError && error.status === 423 ? 3 : 1)
  })
}
