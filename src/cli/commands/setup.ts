/** Commands that run without reaching boardd: running one (`serve`), installing the skill, choosing which boardd to use. */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BoardsClient, DEFAULT_PORT, remoteConfigPath, socketPathFor, transportFor, type RemoteConfig } from '../../shared/client.ts'
import { API_VERSION, type DatabaseRestore } from '../../shared/types.ts'
import type { Command, CommandGroup } from '../command.ts'
import { installedAgentSkills, noAgentsMessage } from '../agents.ts'
import { shipped } from '../shipped.ts'

export interface ReleaseIdentity { version: string, revision: string }
let releaseIdentity: () => ReleaseIdentity = () => ({ version: 'dev', revision: 'dev' })
export function presentRelease(identity: () => ReleaseIdentity) { releaseIdentity = identity }

/**
 * `boardlab install [--dir DIR]`: write the boardlab skill that ships with this CLI into the current directory (or DIR),
 * as SKILL.md with the files it refers to, for agents working there. A SKILL.md that is not boardlab's is kept as
 * SKILL.md.bak. `-g` puts it into every installed agent's own skill directory instead (Claude Code, codex, opencode,
 * hermes), replacing an older copy.
 */
function installSkill(dir: string | undefined, agents: boolean, json: boolean) {
  const source = shipped('skills/boardlab', dir => existsSync(join(dir, 'SKILL.md')))
  if (!source) throw new Error('找不到随 boardlab 一起安装的 skill（skills/boardlab）；重新安装 boardlab')
  const installed: string[] = []
  let backup: string | null = null
  const replaced: string[] = []
  if (agents) {
    const home = process.env.HOME ?? homedir()
    const found = installedAgentSkills(home)
    if (!found.length) throw new Error(noAgentsMessage('装到当前目录用 boardlab install'))
    for (const item of found) {
      const target = item.directory
      mkdirSync(target, { recursive: true })
      // An older copy is replaced, as is the skill's former name `boards`.
      if (existsSync(join(target, 'boardlab')) || existsSync(join(target, 'boards'))) replaced.push(item.agent)
      rmSync(join(target, 'boards'), { recursive: true, force: true })
      rmSync(join(target, 'boardlab'), { recursive: true, force: true })
      cpSync(source, join(target, 'boardlab'), { recursive: true })
      installed.push(`${item.agent}: ${join(target, 'boardlab')}`)
    }
  } else {
    const target = resolve(dir ?? '.')
    mkdirSync(target, { recursive: true })
    const skill = join(target, 'SKILL.md')
    if (existsSync(skill) && !/^name: boardlab$/m.test(readFileSync(skill, 'utf8'))) {
      backup = `${skill}.bak`
      cpSync(skill, backup)
    }
    cpSync(source, target, { recursive: true })
    installed.push(skill)
  }
  if (json) return console.log(JSON.stringify({ installed, replaced, backup }))
  for (const path of installed) console.log(`已安装 boardlab skill -> ${path}`)
  if (replaced.length) console.log(`覆盖了旧版本：${replaced.join('、')}`)
  if (backup) console.log(`原来的 SKILL.md 不是 boardlab 的，备份到 ${backup}`)
}

/** `boardlab remote set <url> [--user U] [--password-stdin]`, `boardlab remote show`, `boardlab remote clear`. */
async function remoteCommand(rest: string[], flags: Map<string, string | true>, json: boolean) {
  const file = remoteConfigPath()
  const sub = rest[0]
  if (sub === 'set') {
    const url = rest[1]
    if (!url) throw new Error('用法：boardlab remote set <ssh://user@host | https://host/boardlab/> [--user <名字>] [--password-stdin]')
    const user = typeof flags.get('user') === 'string' ? flags.get('user') as string : undefined
    const password = flags.has('password-stdin') ? readFileSync(0, 'utf8').trim() : undefined
    const config: RemoteConfig = { url, ...(user ? { user } : {}), ...(password ? { password } : {}) }
    transportFor(config)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 })
    chmodSync(file, 0o600)
    const state = await new BoardsClient(transportFor(config)).state()
    return json ? console.log(JSON.stringify({ url, user: user ?? null, boards: state.boards.length })) : console.log(`已连上 ${url}：${state.boards.length} 块板子，你是 ${state.you}`)
  }
  if (sub === 'clear') { if (existsSync(file)) writeFileSync(file, '{}', { mode: 0o600 }); return console.log('已改回本机的 boardd') }
  let config: RemoteConfig | null = null
  try { config = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  const url = process.env.BOARDS_REMOTE ?? config?.url ?? null
  return json ? console.log(JSON.stringify({ url, user: config?.user ?? null })) : console.log(url ? `远程 boardd：${url}${config?.user ? `（${config.user}）` : ''}${process.env.BOARDS_REMOTE ? '（来自 BOARDS_REMOTE）' : ''}` : '用本机的 boardd')
}

const serve: Command = {
  name: 'serve',
  standalone: true,
  usage: [
    `serve [--port ${DEFAULT_PORT}] [--host <额外监听地址,…>] [--origin <反向代理的网页地址,…>] [--state-dir <dir>]`,
    '      [--config <boardd.json>] [--modules <模块,…>] [--ui <网页目录> | --no-ui]\t运行 boardd：装哪些模块和设置见 --config（默认 <state-dir>/boardd.json，没有就全装）；--ui 换一个网页，--no-ui 只提供 /api',
    '      --supervisor\t自己守着端口和 socket，装后代（--worker）跑 boardd；更新时新一代接手新连接，旧的跑完已有连接和任务再退',
  ],
  async run({ flag, flags, argv, stateDir, catalog }) {
    const { startBoardd } = await import('../../server/main.ts')
    // The default UI built with boardlab, another one given, or none (an API-only boardd).
    const uiDir = flags.has('no-ui') ? null : flag('ui') ? resolve(flag('ui')!) : shipped('dist/ui', dir => existsSync(join(dir, 'index.html')) || existsSync(join(dir, 'frontends.json')))
    const firmwareDir = shipped('firmware', dir => existsSync(join(dir, 'firmware.json'))) ?? undefined
    const hosts = (flag('host') ?? process.env.BOARDS_HOSTS)?.split(',').map(host => host.trim()).filter(Boolean)
    const origins = (flag('origin') ?? process.env.BOARDS_ORIGINS)?.split(',').map(origin => origin.trim()).filter(Boolean)
    // boardd runs this same CLI for older clients' unknown commands (POST /api/cli).
    const cli = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : undefined
    const modules = flag('modules')?.split(',').map(id => id.trim()).filter(Boolean)
    const { version, revision } = cliVersion()
    if (flags.has('supervisor')) {
      if (!cli) throw new Error('serve --supervisor 需要从装好的 CLI 文件运行')
      const { supervise } = await import('../../server/supervisor.ts')
      return supervise({ stateDir, cli, args: argv.filter(arg => arg !== '--supervisor' && arg !== '--worker'), version, revision, port: flag('port') ? Number(flag('port')) : DEFAULT_PORT, hosts: hosts ?? [] })
    }
    const supervisor = flags.has('worker') ? await import('../../server/supervisor.ts') : null
    // A worker started beside another live one shares its database: it leaves a damaged file to that one (exiting non-zero).
    const sharedDatabase = !!supervisor && process.env[supervisor.SHARED_DATABASE_ENV] === '1'
    // A supervisor that owns the port and the socket hands this worker its connections (protocol 2); an older one has
    // the worker listen through the cluster module.
    const handed = !!supervisor && process.env[supervisor.SUPERVISOR_PROTOCOL_ENV] === '2'
    const requests: string[] = []
    const observe = handed ? (method: string, path: string) => { requests.push(`${method} ${path}`); if (requests.length > 8) requests.shift() } : undefined
    const boardd = await startBoardd({ stateDir, catalog, shipped: path => shipped(path), port: flag('port') ? Number(flag('port')) : undefined, hosts, origins, uiDir, firmwareDir, cli, config: flag('config'), modules, version, revision, worker: flags.has('worker'), sharedDatabase, handed, observe })
    console.log(`boardd 已启动：${boardd.hosts.map(host => `http://${host}:${boardd.port}/`).join('  ')}  socket ${socketPathFor(stateDir)}${boardd.uiDir ? '' : flags.has('no-ui') ? '（不带网页）' : '（网页未构建）'}`)
    console.log(`模块：${boardd.lab.modules().map(item => item.id).join(', ') || '（无）'}${boardd.config.source ? `（配置 ${boardd.config.source}）` : ''}`)
    const stop = async () => { await boardd.close(); process.exit(0) }
    if (supervisor && handed) {
      const { superviseWorker } = await import('../../server/worker.ts')
      // BOARDLAB_DRAIN_CAP_MS: how long a drained worker may keep its connections (default 6 hours).
      const cap = Number(process.env.BOARDLAB_DRAIN_CAP_MS)
      superviseWorker(boardd, { version, revision, requests, wanted: supervisor.workerExecArgv(process.arch, process.env, []), ...(cap > 0 ? { drainCapMs: cap } : {}) })
    } else if (supervisor) {
      process.send?.({ type: 'ready', version, revision })
      // The supervisor starts a new worker and asks this one to stop taking background work; its existing connections
      // (console and event streams) and the tasks it runs live on until they end.
      process.on('message', message => { if ((message as { type?: string } | undefined)?.type === 'drain') boardd.lab.stop() })
    }
    process.on('SIGINT', stop); process.on('SIGTERM', stop)
  },
}

const install: Command = {
  name: 'install',
  standalone: true,
  usage: ['install [--dir <目录>] | install -g\t把随 boardlab 安装的 skill 写到当前目录（SKILL.md 和它用到的文件），给在这里工作的 agent 用；-g 装进这台机器上每个装了的 agent 的 skill 目录（Claude Code、codex、opencode、hermes），覆盖旧版本'],
  run: ({ flag, flags, json }) => installSkill(flag('dir'), flags.has('global') || flags.has('agents'), json),
}

const remote: Command = {
  name: 'remote',
  standalone: true,
  usage: ['remote set <ssh://user@host | https://host/boardlab/> [--user <名字>] [--password-stdin] | remote show | remote clear\t用别的机器上的 boardd（只通 ssh 的网络用 ssh://）；也可以设 BOARDS_REMOTE'],
  run: ({ args, flags, json }) => remoteCommand(args, flags, json),
}

export const setupCommands: CommandGroup = { id: 'setup', title: '安装和运行', summary: '状态、版本、安装、连哪台 boardd、运行 boardd、数据库', commands: [install, remote, serve] }

/** This distribution's release identity, supplied at CLI composition. */
function cliVersion(): ReleaseIdentity {
  return releaseIdentity()
}

const version: Command = {
  name: 'version', noBoard: true,
  usage: ['version\t这个 boardlab 命令行的版本，和它连的 boardd 的版本（有新版时说一声）'],
  async run({ client, out }) {
    const mine = cliVersion()
    let boardd: { version?: string, revision?: string, newer?: boolean, latest?: { version: string } | null } | null = null, error: string | null = null
    try { boardd = await client.call('GET', '/api/system/version') } catch (failure) { error = (failure as Error).message }
    // The API version a boardd serves: a client and a boardd of different ones are upgraded to the same release.
    let api: { version: string, revision: string, api: number } | null = null
    try { api = await client.call('GET', '/api/version') } catch {}
    out({ cli: mine, boardd, api, error }, () => {
      console.log(`boardlab ${mine.version}（${mine.revision}）`)
      if (boardd?.version) console.log(`boardd   ${boardd.version}（${boardd.revision}）${boardd.newer && boardd.latest ? `，有新版 ${boardd.latest.version}：boardlab update` : ''}`)
      else console.log(`boardd   ${error ? `连不上：${error}` : '没有版本信息（老版本，或者没装 system 模块）'}`)
      if (api && api.api !== API_VERSION) console.log(`接口     这个 CLI 用 API ${API_VERSION}，boardd 提供 ${api.api}：把两边升级到同一个版本再用`)
    })
  },
}

const status: Command = {
  name: 'status', noBoard: true,
  usage: ['status\t一眼看全：连的是哪台 boardd、你是谁、板子和锁、实验室是否在线、有没有新版'],
  async run({ client, holder, remote, out }) {
    const state = await client.state()
    let v: { version?: string, revision?: string, newer?: boolean, latest?: { version: string } | null } | null = null
    try { v = await client.call('GET', '/api/system/version') } catch {}
    const real = state.boards.filter(board => !board.lab?.empty)
    const mine = real.filter(board => board.lease?.holder === holder)
    const busy = real.filter(board => board.lease && board.lease.holder !== holder)
    // Boardd working on a board is not the same as a lock: a RAM boot or a flash runs without one, so a board can be
    // written while its lock says nobody has it. Calling that idle would offer it to the next person.
    const working = real.filter(board => board.busy && !board.lease)
    const idle = real.length - mine.length - busy.length - working.length
    const attention = real.filter(board => board.lab?.attention)
    const restored = state.restored ?? null
    out({ boardd: client.transport.label, remote, you: holder, version: v, restored, boards: real.length, mine: mine.map(b => b.name), busy: busy.map(b => b.name), working: working.map(b => b.name), attention: attention.map(b => b.name), labs: state.labs }, () => {
      console.log(`boardd   ${client.transport.label}${v?.version ? `  ${v.version}（${v.revision}）` : ''}${v?.newer && v.latest ? `  有新版 ${v.latest.version}：boardlab update` : ''}`)
      if (restored) console.log(restoreText(restored))
      console.log(`你       ${holder}`)
      console.log(`板子     ${real.length} 块：空闲 ${idle}，你拿着 ${mine.length}，别人在用 ${busy.length}${working.length ? `，boardd 在忙 ${working.length}` : ''}${attention.length ? `，${attention.length} 块等人操作` : ''}`)
      for (const board of mine) console.log(`  你的   ${board.name}（${board.lease!.purpose}）`)
      for (const board of working) console.log(`  在忙   ${board.name}：${board.busy!.label}（${board.busy!.by}）`)
      for (const board of attention) console.log(`  等人   ${board.name}：${board.lab!.attention}`)
      for (const lab of state.labs) console.log(`实验室   ${lab.id}  ${!lab.enabled ? '没开' : lab.verifyOk === false ? `连不上：${lab.verifyMessage}` : lab.syncOk === false ? `同步失败：${lab.syncMessage}` : `在线，${lab.syncMessage ?? ''}`}`)
      if (!state.labs.length) console.log('实验室   还没有：网页的设置里添加（或 boardlab lab add）')
    })
  },
}

/** A restore of boardd's database, as `status` warns of it. */
export function restoreText(restored: DatabaseRestore): string {
  const at = restored.at.slice(0, 16).replace('T', ' ')
  return `注意     ${at} boardd 的数据库损坏，${restored.backup ? `用备份 ${restored.backup} 恢复了：这份备份之后的锁、历史和反馈丢了` : '没有可用的备份，用空数据库启动了'}；损坏的文件在 ${restored.aside}。核对过后：boardlab database ack`
}

const database: Command = {
  name: 'database', noBoard: true,
  usage: ['database [ack]\tboardd 的数据库：启动时从备份恢复过就说出来；ack 确认看到了（只有人可以），之后 status 不再提'],
  async run({ args, client, out }) {
    if (args[0] === 'ack') {
      const { acknowledged } = await client.call<{ acknowledged: DatabaseRestore | null }>('POST', '/api/database/acknowledge', {})
      return out({ acknowledged }, () => console.log(acknowledged ? '已确认：status 不再提这次恢复' : '没有要确认的恢复'))
    }
    if (args[0]) throw new Error(`database 不认识 ${args[0]}（只有 ack）`)
    const { restored } = await client.call<{ restored: DatabaseRestore | null }>('GET', '/api/database')
    out({ restored }, () => console.log(restored ? restoreText(restored) : '数据库正常：启动时没有从备份恢复过（或者已经确认过）'))
  },
}

setupCommands.commands.unshift(status, version)
setupCommands.commands.push(database)
