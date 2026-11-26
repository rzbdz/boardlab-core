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
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Module } from '../core/module.ts'
import { resolveBoardlab } from './sdk.ts'
import { marketsDir, readMarket, readRecords, type MarketModule, type MarketRecord, type ModuleMarket } from '../core/module-markets.ts'

// A CLI reads and writes markets without a boardd: what it needs of the manifest format is here, re-exported, so `cli`
// reaches it through this layer like it reaches the catalog.
export { marketsDir, marketsFile, marketsOnDisk, readMarket, readRecords, syncMarket, writeRecords } from '../core/module-markets.ts'
export type { MarketModule, MarketRecord, ModuleMarket } from '../core/module-markets.ts'

/**
 * Where each module's page part is served from, by module id: the directory its module's `ui` file is in, inside the
 * market's copy. Only modules boardd actually loaded (`loaded`) are listed: a market added to browse it does not get
 * its code into every visitor's page. The page imports `/module-ui/<id>/<file>`, and only these directories answer, so
 * no other file of a market is reachable.
 */
export function uiRootsOf(markets: ModuleMarket[], loaded: string[] = []): Record<string, string> {
  const roots: Record<string, string> = {}
  const active = new Set(loaded)
  for (const market of markets) for (const offered of market.modules) if (offered.uiDir && active.has(offered.id)) roots[offered.id] = offered.uiDir
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

/** Whether what a file exported is a module: `{ id, title, setup }`. */
const isModule = (value: unknown): value is Module => !!value && typeof value === 'object' && typeof (value as Module).setup === 'function' && typeof (value as Module).id === 'string'

/**
 * Import a market module's entry file and hand back the module it exports.
 *
 * An entry exports a module object — as its default export, or as a named `module` (a file that also exports what its
 * module is built from has a name for it) — or a function that makes one, called with no arguments. A module built by a
 * function is the same module either way; the function is what a file that takes its settings or its dependencies as
 * arguments can offer without them.
 */
export async function importMarketModule(offered: MarketModule): Promise<Module> {
  const loaded = await import(pathToFileURL(offered.entry).href) as Record<string, unknown>
  // Which export is the module: `default`, `module`, or the one named after the module (`nexus-images` is exported as
  // `nexusImages` by a file that also exports the parts it is made from). Only those: a random export is never called.
  const camel = offered.id.replace(/[-.]([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())
  const exported = loaded.default ?? loaded.module ?? loaded[offered.id] ?? loaded[camel]
  const module = (typeof exported === 'function' ? (exported as () => unknown)() : exported) as unknown
  if (!isModule(module)) {
    throw new Error(`${offered.market}：${offered.id} 的 ${offered.entry} 没有导出一个模块（默认导出、或叫 module 的导出，或一个返回它的函数；要是 { id, title, setup }）`)
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
export async function marketModules(stateDir: string, selection: Record<string, Record<string, unknown>>, builtIn: string[], sdk: string): Promise<{ loaded: Array<{ module: Module, settings: Record<string, unknown> }>, failed: Array<{ id: string, problem: string }> }> {
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
  const failed: Array<{ id: string, problem: string }> = []
  for (const [id, list] of wanted) {
    if (builtIn.includes(id)) throw new Error(`模块 ${id} 随 boardlab 提供，不能从市场再装一个（${list.map(item => item.offered.market).join('、')}）`)
    if (list.length > 1) throw new Error(`模块 ${id} 有几个市场都提供：${list.map(item => item.offered.market).join('、')}（只留一个市场）`)
    const { offered, settings } = list[0]!
    // One market module that cannot be imported is that module's failure, not boardd's: a market is the machine
    // owner's own choice, and the rest of the lab — and the page that says what is wrong with it — has to come up.
    try { loaded.push({ module: await importMarketModule(offered), settings }) }
    catch (error) { failed.push({ id, problem: `${offered.market}/${id}: ${(error as Error).message}` }) }
  }
  return { loaded, failed }
}
