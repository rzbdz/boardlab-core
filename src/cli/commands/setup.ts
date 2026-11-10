/** Commands that run without reaching boardd: running one (`serve`), installing the skill, choosing which boardd to use. */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BoardsClient, DEFAULT_PORT, remoteConfigPath, socketPathFor, transportFor, type RemoteConfig } from '../../shared/client.ts'
import type { Command, CommandGroup } from '../command.ts'
import { shipped } from '../shipped.ts'

/** Where each agent reads skills from, under the home directory; the agent counts as installed when its own directory exists. */
const AGENT_SKILLS: Array<{ agent: string, home: string, skills: string }> = [
  { agent: 'Claude Code', home: '.claude', skills: '.claude/skills' },
  { agent: 'codex', home: '.codex', skills: '.codex/skills' },
  { agent: 'opencode', home: '.config/opencode', skills: '.config/opencode/skill' },
  { agent: 'hermes', home: '.hermes', skills: '.hermes/skills/embedded' },
]

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
    const found = AGENT_SKILLS.filter(item => existsSync(join(home, item.home)))
    if (!found.length) throw new Error(`这台机器上没找到 agent（${AGENT_SKILLS.map(item => `~/${item.home}`).join('、')} 都不存在）；装到当前目录用 boardlab install`)
    for (const item of found) {
      const target = join(home, item.skills)
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
  ],
  async run({ flag, flags, stateDir, catalog }) {
    const { startBoardd } = await import('../../server/main.ts')
    // The default UI built with boardlab, another one given, or none (an API-only boardd).
    const uiDir = flags.has('no-ui') ? null : flag('ui') ? resolve(flag('ui')!) : shipped('dist/ui', dir => existsSync(join(dir, 'index.html')) || existsSync(join(dir, 'frontends.json')))
    const firmwareDir = shipped('firmware', dir => existsSync(join(dir, 'firmware.json'))) ?? undefined
    const hosts = (flag('host') ?? process.env.BOARDS_HOSTS)?.split(',').map(host => host.trim()).filter(Boolean)
    const origins = (flag('origin') ?? process.env.BOARDS_ORIGINS)?.split(',').map(origin => origin.trim()).filter(Boolean)
    // boardd runs this same CLI for older clients' unknown commands (POST /api/cli).
    const cli = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : undefined
    const modules = flag('modules')?.split(',').map(id => id.trim()).filter(Boolean)
    const boardd = await startBoardd({ stateDir, catalog, shipped: path => shipped(path), port: flag('port') ? Number(flag('port')) : undefined, hosts, origins, uiDir, firmwareDir, cli, config: flag('config'), modules })
    console.log(`boardd 已启动：${boardd.hosts.map(host => `http://${host}:${boardd.port}/`).join('  ')}  socket ${socketPathFor(stateDir)}${boardd.uiDir ? '' : flags.has('no-ui') ? '（不带网页）' : '（网页未构建）'}`)
    console.log(`模块：${boardd.lab.modules().map(item => item.id).join(', ') || '（无）'}${boardd.config.source ? `（配置 ${boardd.config.source}）` : ''}`)
    const stop = async () => { await boardd.close(); process.exit(0) }
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

export const setupCommands: CommandGroup = { title: '安装和运行', commands: [install, remote, serve] }
