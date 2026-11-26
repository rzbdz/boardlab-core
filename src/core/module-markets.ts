/**
 * A market of boardlab modules: a git repository of module packages, each a directory with an entry file, plus a
 * `market.json` at the root naming them. A module is code — an ES module whose default export is a module — so a market
 * is how code reaches boardd without shipping another release.
 *
 * A market says what it offers before boardd loads any of it: `market.json` carries each module's id, title, tags and
 * what it needs and offers. That is what a person searches, and what boardd checks before it imports anything. The
 * manifest is the market's claim; the module itself is still the truth about what it provides once loaded.
 *
 *   market.json
 *   { "modules": [
 *       { "id": "images", "title": "镜像", "tags": ["images", "market"],
 *         "entry": "images/module.js", "ui": "images/ui.js", "inject": [], "provide": [] } ] }
 *
 * `entry` defaults to `<id>/module.js`, then `<id>/index.js`; `ui` is optional, and is what a page imports to render the
 * module's part of it (`{ module, views }`, see `ui/contract.ts`). A `ui` file is a browser module as it is: a market
 * that writes one in TypeScript builds it before it pushes.
 *
 * Nothing here runs code: an entry is only checked to be there, and `digestOf` hashes it, so a market update shows which
 * modules changed before anything is imported.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** What a market offers: one module, as the market's manifest describes it (no code has run). */
export interface MarketModule {
  id: string
  title: string
  about: string
  tags: string[]
  /** Services it needs before it runs. */
  inject: string[]
  /** Services it offers. */
  provide: string[]
  version: string | null
  /** The market it comes from. */
  market: string
  /** Its entry file, absolute. */
  entry: string
  /** What a page imports for this module's part of it, at `module-ui/<module>/<file>` (relative: a page works under a sub-path); null when it brings none. */
  ui: string | null
  /** The directory that page part is served from, absolute; null when it brings none. Nothing else of it is served. */
  uiDir: string | null
  /** sha256 of the entry file: a market update that changes the code changes this. */
  digest: string
}

/** A market boardd knows: where its copy is, where it came from, and the commit a person agreed to. */
export interface ModuleMarket {
  id: string
  url: string
  branch: string | null
  /** The commit that was there when it was added or last updated, or null if it was never fetched. */
  commit: string | null
  /** The copy on this machine. */
  dir: string
  /** What the copy says it offers now. */
  modules: MarketModule[]
  /** What is wrong with the copy (a manifest that cannot be read, an entry file that is not there). */
  problems: string[]
}

/** One market, as it is written in `<state>/markets.json`. */
export interface MarketRecord { id: string, url: string, branch: string | null, commit: string | null }

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const isMap = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' && value ? value : null
const words = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

export const digestOf = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Where an entry file is for a module whose manifest names none: `<id>/module.js`, else `<id>/index.js`. */
function entryFor(dir: string, id: string): string | null {
  for (const name of ['module.js', 'module.mjs', 'index.js', 'index.mjs']) {
    const path = join(dir, id, name)
    if (existsSync(path)) return path
  }
  return null
}

/**
 * What the copy of a market at `dir` offers, read without running any of it. An entry named in the manifest must exist:
 * a market that names a file it does not carry is a problem, not a module that fails later.
 */
export function readMarket(id: string, dir: string): { modules: MarketModule[], problems: string[] } {
  const problems: string[] = []
  const manifest = join(dir, 'market.json')
  if (!existsSync(manifest)) return { modules: [], problems: [`${id}：没有 market.json（市场根上要有，列出它提供哪些模块）`] }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(manifest, 'utf8')) }
  catch (error) { return { modules: [], problems: [`${id}：market.json 读不了：${(error as Error).message}`] } }
  if (!isMap(raw) || !Array.isArray(raw.modules)) return { modules: [], problems: [`${id}：market.json 要是一个对象，带 modules 数组`] }
  const modules: MarketModule[] = []
  const seen = new Set<string>()
  for (const item of raw.modules) {
    if (!isMap(item) || !text(item.id) || !ID.test(text(item.id)!)) { problems.push(`${id}：有一项没有合法的 id`); continue }
    const moduleId = text(item.id)!
    if (seen.has(moduleId)) { problems.push(`${id}：${moduleId} 写了两次`); continue }
    seen.add(moduleId)
    const named = text(item.entry)
    const entry = named ? resolve(dir, named) : entryFor(dir, moduleId)
    if (!entry || !inside(dir, entry)) { problems.push(`${id}：${moduleId} 的 entry ${named ?? '（没写）'} 不在市场目录里`); continue }
    if (!existsSync(entry)) { problems.push(`${id}：${moduleId} 的 entry ${relative(dir, entry)} 不在`); continue }
    const uiName = text(item.ui)
    const uiFile = uiName ? resolve(dir, uiName) : null
    // A page part a market cannot serve is said, and costs only that part: the module itself still loads. It is never
    // `.git` (a clone's config holds the URL and token it was cloned with) nor anything outside the copy through a
    // symlink; both checks are on the real path, as boardd serves it.
    let ui: string | null = null, uiDir: string | null = null
    if (uiName) {
      const real = uiFile ? realOf(uiFile) : null
      if (!uiFile || !inside(dir, uiFile) || !real || !inside(dir, real) || real.split(sep).includes('.git')) problems.push(`${id}：${moduleId} 的 ui ${uiName} 不能从市场里提供（要在市场目录里，且不在 .git 里）`)
      else if (!existsSync(uiFile)) problems.push(`${id}：${moduleId} 的 ui ${uiName} 不在，页面部分不会出现`)
      else { ui = `module-ui/${moduleId}/${uiName.slice(uiName.lastIndexOf('/') + 1)}`; uiDir = dirname(real) }
    }
    modules.push({
      id: moduleId, title: text(item.title) ?? moduleId, about: text(item.about) ?? '', tags: words(item.tags),
      inject: words(item.inject), provide: words(item.provide), version: text(item.version), market: id, entry, ui, uiDir, digest: digestOf(entry),
    })
  }
  return { modules, problems }
}

/** The markets a boardd has: `<state>/markets.json` says which, and each has a copy under `<state>/markets/<id>`. */
export function marketsDir(stateDir: string) { return join(stateDir, 'markets') }
export function marketsFile(stateDir: string) { return join(stateDir, 'markets.json') }

/** `path` is inside `dir` (and not `dir` itself or a sibling whose name starts with `dir`'s). */
function inside(dir: string, path: string): boolean {
  const base = resolve(dir)
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** Where a path really is, symlinks followed; null when it is not there. */
function realOf(path: string): string | null {
  try { return realpathSync(path) } catch { return null }
}

/** The page parts of the modules boardd loaded, by id and URL: what the page imports. */
export function uiPartsOf(markets: ModuleMarket[], loaded: string[]): Array<{ id: string, ui: string }> {
  const active = new Set(loaded)
  return markets.flatMap(market => market.modules.filter(module => module.ui && active.has(module.id)).map(module => ({ id: module.id, ui: module.ui! })))
}

/** The records in `markets.json`; a file that cannot be read is a problem, not a boardd that will not start. */
export function readRecords(stateDir: string): { records: MarketRecord[], problems: string[] } {
  const file = marketsFile(stateDir)
  if (!existsSync(file)) return { records: [], problems: [] }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { return { records: [], problems: [`markets.json 读不了：${(error as Error).message}`] } }
  if (!isMap(raw) || !Array.isArray(raw.markets)) return { records: [], problems: ['markets.json 要是一个对象，带 markets 数组'] }
  const records: MarketRecord[] = []
  const problems: string[] = []
  for (const item of raw.markets) {
    if (!isMap(item) || !text(item.id) || !text(item.url)) { problems.push('markets.json 里有一项没有 id 或 url'); continue }
    records.push({ id: text(item.id)!, url: text(item.url)!, branch: text(item.branch), commit: text(item.commit) })
  }
  return { records, problems }
}

/** Write the records back to `markets.json`: what the next boardd process reads. */
export function writeRecords(stateDir: string, records: MarketRecord[]) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(marketsFile(stateDir), `${JSON.stringify({ markets: records }, null, 2)}\n`)
}

/** The markets on this machine, each with what its copy says now (what the CLI and the page both show). */
export function marketsOnDisk(stateDir: string): { markets: Array<MarketRecord & { modules: MarketModule[], problems: string[] }>, problems: string[] } {
  const { records, problems } = readRecords(stateDir)
  const markets = records.map(record => {
    const dir = join(marketsDir(stateDir), record.id)
    const read = existsSync(join(dir, 'market.json')) ? readMarket(record.id, dir) : { modules: [], problems: [`${record.id}：还没拉取（boardlab market update ${record.id}）`] }
    return { ...record, modules: read.modules, problems: read.problems }
  })
  return { markets, problems }
}

interface Run { code: number, stdout: string, stderr: string }

/**
 * Run git in a market's copy. A market is a git repository outside this program: it is fetched, never installed, so
 * this is the whole of boardlab's git use. No prompt (a private repository's key must be in the agent's
 * configuration; the caller passes `env`), a bounded time, and the last line of stderr as the error.
 */
function runGit(args: string[], options: { cwd?: string, env?: NodeJS.ProcessEnv } = {}): Promise<Run> {
  return new Promise(resolve => {
    execFile('git', args, { cwd: options.cwd, env: options.env, maxBuffer: 32 * 1024 * 1024, timeout: 600_000 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (error ? error.message : '')) }))
  })
}
const lastLine = (run: Run) => (run.stderr || run.stdout).trim().split('\n').filter(Boolean).at(-1) ?? `退出码 ${run.code}`

/**
 * Fetch or update one market's copy under the state directory, and say which commit it is at. A shallow clone: boardlab
 * reads a market's files, and does not need its history. `env` is the environment git runs with: a caller supplies it
 * (no prompt, a stable locale) rather than the core reading one itself.
 */
export async function syncMarket(stateDir: string, id: string, options: { url: string, branch?: string | null, env?: NodeJS.ProcessEnv }): Promise<{ commit: string, dir: string }> {
  mkdirSync(marketsDir(stateDir), { recursive: true })
  const dir = join(marketsDir(stateDir), id)
  const branch = options.branch ?? null
  if (await runGit(['rev-parse', '--git-dir'], { cwd: dir, env: options.env }).then(run => run.code === 0)) {
    const fetched = await runGit(['fetch', '--depth', '1', 'origin', branch ?? 'HEAD'], { cwd: dir, env: options.env })
    if (fetched.code !== 0) throw new Error(`${id}：拉不到 ${options.url}：${lastLine(fetched)}`)
    const checkout = await runGit(['checkout', '-q', 'FETCH_HEAD'], { cwd: dir, env: options.env })
    if (checkout.code !== 0) throw new Error(`${id}：切换到新版本失败：${lastLine(checkout)}`)
  } else {
    rmSync(dir, { recursive: true, force: true })
    const cloned = await runGit(['clone', '-q', '--depth', '1', ...(branch ? ['-b', branch] : []), options.url, dir], { env: options.env })
    if (cloned.code !== 0) throw new Error(`${id}：克隆不了 ${options.url}：${lastLine(cloned)}`)
  }
  const head = await runGit(['rev-parse', 'HEAD'], { cwd: dir, env: options.env })
  if (head.code !== 0) throw new Error(`${id}：读不出 ${dir} 的版本：${lastLine(head)}`)
  return { commit: head.stdout.trim(), dir }
}
