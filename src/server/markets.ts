/**
 * The markets a boardd loads modules from, and the loader that puts them into its plugin runtime.
 *
 * A market is a git repository; boardd keeps one copy of each under its state directory and loads the modules its
 * configuration selects from there at start, so a market's code runs for the life of a boardd rather than being
 * swapped under it. Adding or updating a market is a git operation in the state directory. A market's modules are
 * listed from what the copy says they offer (see `module-markets.ts`) and imported by their file URL, so a market needs
 * no `node_modules` on the machine.
 *
 * `sdk` is where this build keeps the surface a market module imports as `boardlab` (`dist/sdk.js`).
 *
 * What a market offers and what a module does are kept apart: the manifest is what boardd imports and what a person
 * searches; the module, once imported, is the truth about what it injects and provides.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Module } from '../core/module.ts'
import { resolveBoardlab } from './sdk.ts'
import { marketsDir, readMarket, readRecords, type MarketModule, type MarketRecord, type ModuleMarket } from '../core/module-markets.ts'

// A CLI reads and writes markets without a boardd: what it needs of the manifest format is here, re-exported, so `cli`
// reaches it through this layer like it reaches the catalog.
export { marketsDir, marketsFile, readMarket, readRecords } from '../core/module-markets.ts'
export type { MarketModule, MarketRecord, ModuleMarket } from '../core/module-markets.ts'

interface Run { code: number, stdout: string, stderr: string }
const git = (args: string[], cwd?: string): Promise<Run> => new Promise(resolve =>
  execFile('git', args, { cwd, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 32 * 1024 * 1024, timeout: 600_000 },
    (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (error ? error.message : '')) })))
const last = (run: Run) => (run.stderr || run.stdout).trim().split('\n').filter(Boolean).at(-1) ?? `退出码 ${run.code}`

/**
 * Where each module's page part is served from, by module id: the directory its module's `ui` file is in, inside the
 * market's copy. The page imports `/module-ui/<id>/<file>`, and only these directories answer, so no other file of a
 * market is reachable.
 */
export function uiRootsOf(markets: ModuleMarket[]): Record<string, string> {
  const roots: Record<string, string> = {}
  for (const market of markets) for (const offered of market.modules) if (offered.uiDir) roots[offered.id] = offered.uiDir
  return roots
}

/** What a market's copy says now, with the record it was made from. */
function describe(record: MarketRecord, stateDir: string): ModuleMarket {
  const dir = join(marketsDir(stateDir), record.id)
  const { modules, problems } = readMarket(record.id, dir)
  return { id: record.id, url: record.url, branch: record.branch, commit: record.commit, dir, modules, problems }
}

/** The markets this boardd has, as their copies describe them. */
export function marketsOf(stateDir: string): ModuleMarket[] {
  const { records } = readRecords(stateDir)
  return records.map(record => describe(record, stateDir))
}

/** Fetch or update one market's copy, and say which commit it is at. */
export async function syncMarket(stateDir: string, id: string, options: { url: string, branch?: string | null }): Promise<{ commit: string, dir: string }> {
  mkdirSync(marketsDir(stateDir), { recursive: true })
  const dir = join(marketsDir(stateDir), id)
  const branch = options.branch ?? null
  if (await git(['rev-parse', '--git-dir'], dir).then(run => run.code === 0)) {
    const fetched = await git(['fetch', '--depth', '1', 'origin', branch ?? 'HEAD'], dir)
    if (fetched.code !== 0) throw new Error(`${id}：拉不到 ${options.url}：${last(fetched)}`)
    const checkout = await git(['checkout', '-q', 'FETCH_HEAD'], dir)
    if (checkout.code !== 0) throw new Error(`${id}：切换到新版本失败：${last(checkout)}`)
  } else {
    rmSync(dir, { recursive: true, force: true })
    const cloned = await git(['clone', '-q', '--depth', '1', ...(branch ? ['-b', branch] : []), options.url, dir])
    if (cloned.code !== 0) throw new Error(`${id}：克隆不了 ${options.url}：${last(cloned)}`)
  }
  const head = await git(['rev-parse', 'HEAD'], dir)
  if (head.code !== 0) throw new Error(`${id}：读不出 ${dir} 的版本：${last(head)}`)
  return { commit: head.stdout.trim(), dir }
}

/** Import a market module's entry file and hand back the module it exports. */
export async function importMarketModule(offered: MarketModule): Promise<Module> {
  const loaded = await import(pathToFileURL(offered.entry).href) as { default?: unknown }
  const module = loaded.default as Module | undefined
  if (!module || typeof module !== 'object' || typeof module.setup !== 'function' || typeof module.id !== 'string') {
    throw new Error(`${offered.market}：${offered.id} 的 ${offered.entry} 没有默认导出一个模块（要 { id, title, setup }）`)
  }
  // The id the manifest offers is the id it is configured by: a module that exports another one is not what was asked.
  if (module.id !== offered.id) throw new Error(`${offered.market}：${offered.id} 的模块说自己是 ${module.id}`)
  return module
}

/**
 * The modules a selection takes from the markets (`{id: settings}`), imported. A module a market lists but nobody asks
 * for is not imported: a market is a shop, not a load order. Two markets offering the same id, or a market offering an
 * id the distribution already has, is refused before anything is imported.
 */
export async function marketModules(stateDir: string, selection: Record<string, Record<string, unknown>>, builtIn: string[], sdk: string): Promise<Array<{ module: Module, settings: Record<string, unknown> }>> {
  const markets = marketsOf(stateDir)
  const wanted = new Map<string, Array<{ offered: MarketModule, settings: Record<string, unknown> }>>()
  for (const market of markets) {
    for (const offered of market.modules) {
      if (!(offered.id in selection)) continue
      const list = wanted.get(offered.id) ?? []
      list.push({ offered, settings: selection[offered.id] ?? {} })
      wanted.set(offered.id, list)
    }
  }
  // A market module reaches boardlab through `import 'boardlab'`: the SDK this build carries, resolved before the first
  // of them is imported. Without it a module would need boardlab on the machine as a package.
  if (wanted.size) resolveBoardlab(pathToFileURL(sdk).href)
  const loaded: Array<{ module: Module, settings: Record<string, unknown> }> = []
  for (const [id, list] of wanted) {
    if (builtIn.includes(id)) throw new Error(`模块 ${id} 随 boardlab 提供，不能从市场再装一个（${list.map(item => item.offered.market).join('、')}）`)
    if (list.length > 1) throw new Error(`模块 ${id} 有几个市场都提供：${list.map(item => item.offered.market).join('、')}（只留一个市场）`)
    const { offered, settings } = list[0]!
    loaded.push({ module: await importMarketModule(offered), settings })
  }
  return loaded
}
