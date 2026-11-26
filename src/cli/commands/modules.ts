/**
 * `boardlab market`: the module markets this machine's boardd loads modules from, and `boardlab module search` across
 * them. A market is a git repository of module packages (see `core/module-markets.ts`); the CLI keeps a copy of each
 * under boardd's state directory and boardd imports the modules its configuration selects from there.
 *
 * A market changes what the next boardd process loads, so these commands write to the state directory directly rather
 * than through a running boardd: they work whether boardd is up or not, and a running boardd keeps what it started with.
 * The state directory is boardd's own, so a CLI talking to a boardd elsewhere runs these there (`boarddState`), where
 * that state is: the market's copies, its commits and the configuration the next start reads are all on that machine.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { marketsDir, marketsFile, marketsOf, readMarket, readRecords, syncMarket, type MarketRecord } from '../../server/markets.ts'

/** Git's own environment for a market fetch: no prompt, and a C locale so a message parses the same everywhere. */
const GIT_ENV = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }
import type { Command, CommandGroup } from '../command.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function save(stateDir: string, records: MarketRecord[]) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(marketsFile(stateDir), `${JSON.stringify({ markets: records }, null, 2)}\n`)
}

const commands: Command[] = [
  {
    name: 'market', noBoard: true, boarddState: true,
    usage: [
      'market\tboardd 那台机器从哪些模块市场装模块，各自提供什么（连别的机器上的 boardd 时在那边读写）',
      'market add <市场> <git 地址> [--branch <分支>]\t加一个模块市场：克隆一份到 boardd 的状态目录里，下次启动 boardd 时可用',
      'market update [<市场>|--all]\t拉取市场的新版本（不给就是全部），改了什么会列出来；下次启动 boardd 生效',
      'market remove <市场> [--yes]\t删掉一个模块市场和它在 boardd 那台机器上的复制品（配置里从它装的模块会变成没装）',
      'market show <市场>\t一个市场提供哪些模块：id、说明、标签、要什么、给什么',
    ],
    async run({ args, flag, flags, out, stateDir }) {
      const { records, problems } = readRecords(stateDir)
      const action = args[0]
      if (!action || action === 'list') {
        const markets = marketsOf(stateDir)
        return out({ markets, problems }, () => {
          for (const problem of problems) console.log(`注意：${problem}`)
          if (!markets.length) return console.log('还没有模块市场：boardlab market add <市场> <git 地址>')
          for (const market of markets) {
            console.log(`${market.id}  ${market.url}${market.branch ? `（${market.branch}）` : ''}  ${market.commit ? market.commit.slice(0, 12) : '还没拉取'}`)
            console.log(`  ${market.modules.length} 个模块：${market.modules.map(module => module.id).join('、') || '（无）'}`)
            for (const problem of market.problems) console.log(`  注意：${problem}`)
          }
        })
      }
      if (action === 'add') {
        const [id, url] = [args[1], args[2]]
        if (!id || !url) throw new Error('用法：boardlab market add <市场> <git 地址> [--branch <分支>]')
        if (!ID.test(id)) throw new Error(`市场名 ${id}：只能用字母、数字、点、下划线和短横线`)
        if (records.some(record => record.id === id)) throw new Error(`已经有市场 ${id}：boardlab market update ${id}`)
        const branch = flag('branch') ?? null
        const synced = await syncMarket(stateDir, id, { url, branch, env: GIT_ENV })
        const { modules, problems: readProblems } = readMarket(id, synced.dir)
        save(stateDir, [...records, { id, url, branch, commit: synced.commit }])
        return out({ id, url, branch, commit: synced.commit, modules, problems: readProblems }, () => {
          console.log(`加了模块市场 ${id}（${synced.commit.slice(0, 12)}）：${modules.length} 个模块${modules.length ? `：${modules.map(module => module.id).join('、')}` : ''}`)
          for (const problem of readProblems) console.log(`注意：${problem}`)
          console.log('要装哪个，把它写进 boardd 的配置（modules），然后重启 boardd')
        })
      }
      if (action === 'show') {
        const market = marketsOf(stateDir).find(item => item.id === args[1])
        if (!market) throw new Error(`没有市场 ${args[1] ?? '（没写）'}：boardlab market 列出有的`)
        return out(market, () => {
          console.log(`${market.id}  ${market.url}${market.branch ? `（${market.branch}）` : ''}  ${market.commit?.slice(0, 12) ?? '还没拉取'}`)
          for (const problem of market.problems) console.log(`注意：${problem}`)
          for (const module of market.modules) {
            const edges = [module.inject.length ? `要 ${module.inject.join('、')}` : '', module.provide.length ? `给 ${module.provide.join('、')}` : '', module.tags.length ? `标签 ${module.tags.join('、')}` : ''].filter(Boolean).join('；')
            console.log(`  ${module.id}  ${module.title}${module.version ? `  ${module.version}` : ''}`)
            if (module.about) console.log(`    ${module.about}`)
            if (edges) console.log(`    ${edges}`)
          }
        })
      }
      if (action === 'update') {
        const all = flags.has('all') || !args[1]
        const chosen = all ? records : records.filter(record => record.id === args[1])
        if (!chosen.length) throw new Error(`没有市场 ${args[1] ?? '（没写）'}：boardlab market 列出有的`)
        const changed: Array<{ id: string, from: string | null, to: string, before: ReturnType<typeof readMarket>, after: ReturnType<typeof readMarket> }> = []
        for (const record of chosen) {
          const before = existsSync(join(marketsDir(stateDir), record.id, 'market.json')) ? readMarket(record.id, join(marketsDir(stateDir), record.id)) : { modules: [], problems: [] }
          const synced = await syncMarket(stateDir, record.id, { url: record.url, branch: record.branch, env: GIT_ENV })
          const after = readMarket(record.id, synced.dir)
          changed.push({ id: record.id, from: record.commit, to: synced.commit, before, after })
          const next = records.map(item => item.id === record.id ? { ...item, commit: synced.commit } : item)
          save(stateDir, next)
          records.splice(0, records.length, ...next)
        }
        return out(changed, () => {
          for (const item of changed) {
            if (item.from === item.to) { console.log(`${item.id} 已经是最新的（${item.to.slice(0, 12)}）`); continue }
            console.log(`${item.id}：${item.from?.slice(0, 12) ?? '（新）'} → ${item.to.slice(0, 12)}`)
            const before = new Map(item.before.modules.map(module => [module.id, module.digest]))
            const after = new Map(item.after.modules.map(module => [module.id, module.digest]))
            for (const [id, digest] of after) {
              if (!before.has(id)) console.log(`  + ${id}（新加的模块）`)
              else if (before.get(id) !== digest) console.log(`  ~ ${id}（代码变了）`)
            }
            for (const id of before.keys()) if (!after.has(id)) console.log(`  - ${id}（市场不再提供）`)
            for (const problem of item.after.problems) console.log(`  注意：${problem}`)
          }
          if (changed.some(item => item.from !== item.to)) console.log('重启 boardd 后生效')
        })
      }
      if (action === 'remove') {
        const id = args[1]
        if (!id) throw new Error('用法：boardlab market remove <市场> [--yes]')
        if (!records.some(record => record.id === id)) throw new Error(`没有市场 ${id}`)
        if (!flags.has('yes')) throw new Error(`删掉市场 ${id} 和它在本机的复制品？配置里从它装的模块下次启动会没有。确认请加 --yes`)
        save(stateDir, records.filter(record => record.id !== id))
        rmSync(join(marketsDir(stateDir), id), { recursive: true, force: true })
        return out({ removed: id }, () => console.log(`删了模块市场 ${id}`))
      }
      throw new Error(`不认识的用法：boardlab market ${args.join(' ')}（boardlab help market）`)
    },
  },
  {
    name: 'module', noBoard: true, boarddState: true,
    usage: [
      'module [list] [--tag <标签>]\tboardd 装了哪些模块：它是什么、要什么、给什么、在不在跑；--tag 只看带这个标签的',
      'module search <文字>\t在装了的模块和模块市场里按名字、说明和标签找',
      'module change <市场> <模块> <设置文件|->\t改一个市场模块在 boardd 配置里的设置（- 从标准输入读 JSON）',
    ],
    async run({ args, client, flag, out, stateDir }) {
      const action = args[0] ?? 'list'
      const state = await client.state()
      const plugins = state.plugins ?? []
      if (action === 'search') {
        const text = args.slice(1).join(' ').toLowerCase()
        if (!text) throw new Error('用法：boardlab module search <文字>')
        const here = plugins.filter(plugin => `${plugin.id} ${plugin.title} ${plugin.about} ${plugin.tags.join(' ')}`.toLowerCase().includes(text))
        const markets = marketsOf(stateDir).flatMap(market => market.modules
          .filter(module => `${module.id} ${module.title} ${module.about} ${module.tags.join(' ')}`.toLowerCase().includes(text))
          .map(module => ({ ...module, entry: undefined })))
        return out({ loaded: here, markets }, () => {
          if (!here.length && !markets.length) return console.log(`没有名字、说明或标签里有「${text}」的模块`)
          if (here.length) {
            console.log('装了的：')
            for (const plugin of here) console.log(`  ${plugin.id}  ${plugin.title}${plugin.about ? `：${plugin.about}` : ''}`)
          }
          if (markets.length) {
            console.log('市场里的（写进 boardd 的 modules 后重启就能装）：')
            for (const module of markets) console.log(`  ${module.market}/${module.id}  ${module.title}${module.about ? `：${module.about}` : ''}`)
          }
        })
      }
      if (action === 'change') {
        const [market, id, file] = [args[1], args[2], args[3]]
        if (!market || !id || !file) throw new Error('用法：boardlab module change <市场> <模块> <设置文件|->')
        const raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8')
        let settings: unknown
        try { settings = JSON.parse(raw) } catch (error) { throw new Error(`设置要是一个 JSON 对象：${(error as Error).message}`) }
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('设置要是一个 JSON 对象')
        const path = flag('config') ?? join(stateDir, 'boardd.json')
        const config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { modules?: unknown } : {}
        const modules = config.modules === undefined ? {} : config.modules
        if (Array.isArray(modules)) throw new Error(`${path} 的 modules 是模块名的列表，改不了设置：把它写成 {模块名: 设置}`)
        config.modules = { ...(modules as object), [id]: settings }
        writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
        return out({ market, module: id, settings, config: path }, () => console.log(`写好了 ${path} 里 ${id} 的设置；重启 boardd 生效`))
      }
      const words = action === 'list' ? args.slice(1) : []
      const tag = flag('tag')
      const found = plugins.filter(plugin => (!tag || plugin.tags.includes(tag)) && (!words.length || words.every(word => `${plugin.id} ${plugin.title} ${plugin.about} ${plugin.tags.join(' ')}`.toLowerCase().includes(word.toLowerCase()))))
      return out(found, () => {
        if (!plugins.length) return console.log('boardd 没有装任何模块')
        if (!found.length) return console.log(`没有符合的模块（装了 ${plugins.length} 个）`)
        const STATUS: Record<string, string> = { active: '在跑', pending: '等着', failed: '起不来', stopped: '停了' }
        for (const plugin of found) {
          console.log(`${plugin.id}  ${plugin.title}  ${STATUS[plugin.status] ?? plugin.status}${plugin.why ? `：${plugin.why}` : ''}`)
          if (plugin.about) console.log(`  ${plugin.about}`)
          const edges = [plugin.inject.length ? `要 ${plugin.inject.join('、')}` : '', plugin.provide.length ? `给 ${plugin.provide.join('、')}` : '', plugin.tags.length ? `标签 ${plugin.tags.join('、')}` : ''].filter(Boolean).join('；')
          if (edges) console.log(`  ${edges}`)
        }
      })
    },
  },
]

export const moduleCommands: CommandGroup = {
  id: 'module', title: '模块与模块市场', summary: '装了哪些模块、它们要什么给什么，以及从哪里（模块市场）装更多',
  commands,
}
