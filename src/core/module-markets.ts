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
 * that writes one in TypeScript builds it before it pushes. `cli` names the module's own `boardlab` commands, and `docs`
 * a directory of help pages (`<module>/<name>`, see `View.help`), which defaults to `docs/` beside the entry.
 *
 * Nothing here runs code: an entry is only checked to be there, and `digestOf` hashes it, so a market update shows which
 * modules changed before anything is imported.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'

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
  /**
   * The ids this module had before, as its manifest says (`was`): a configuration written before a rename names it by
   * one of them, and a lab someone added then is moved to `id`. Read without importing the module.
   */
  was: string[]
  /** The market it comes from. */
  market: string
  /** Its entry file, absolute. */
  entry: string
  /** What a page imports for this module's part of it, at `module-ui/<module>/<file>` (relative: a page works under a sub-path); null when it brings none. */
  ui: string | null
  /**
   * The module's own `boardlab` commands, as a file the boardd that loaded it runs (its `cli.ts`): null when it has none.
   * Commands are the module's code, so they run where the module is loaded, not in a CLI built without it.
   */
  cli: string | null
  /**
   * Its help pages, which are not boardd's: a view names one by name (`view.help`), and a page from a market answers to
   * `<id>/<name>` everywhere, listed and fetched as boardd's own are. Empty when it brings none.
   */
  docs: Array<{ name: string, title: string, file: string }>
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
    const cliName = text(item.cli)
    const cliFile = cliName ? resolve(dir, cliName) : null
    let cli: string | null = null
    if (cliFile) {
      const real = realOf(cliFile)
      if (!inside(dir, cliFile) || !existsSync(cliFile)) problems.push(`${id}：${moduleId} 的 cli ${cliName} 不在，它的命令不会有`)
      else if (!real || !inside(dir, real) || real.split(sep).includes('.git')) problems.push(`${id}：${moduleId} 的 cli ${cliName} 不能从市场里提供（要在市场目录里，且不在 .git 里）`)
      else cli = real
    }
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
    const docs = docsOf(dir, moduleId, item.docs, entry, problems)
    modules.push({
      id: moduleId, title: text(item.title) ?? moduleId, about: text(item.about) ?? '', tags: words(item.tags),
      inject: words(item.inject), provide: words(item.provide), version: text(item.version), was: words(item.was), market: id, entry, ui, uiDir, cli, docs, digest: digestOf(entry),
    })
  }
  return { modules, problems }
}

/** A help page's title: its first `# ` heading, as boardd's own pages get theirs. */
const docTitle = (text: string, name: string) => /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? name

/**
 * A module's help pages: the directory the manifest's `docs` names, or `docs/` beside the module's entry when it names
 * none. Each `.md` file in it is a page called `<module>/<file>` (`view.help`, see `ui/contract.ts`). No such directory
 * is no pages and no problem (a module that needs no help), but a page that is a symlink out of the market or inside
 * `.git` is said and skipped, as a `ui` would be.
 */
function docsOf(dir: string, id: string, named: unknown, entry: string, problems: string[]): Array<{ name: string, title: string, file: string }> {
  const folder = resolve(dir, text(named) ?? join(dirname(relative(dir, entry)), 'docs'))
  if (!existsSync(folder)) {
    if (text(named)) problems.push(`${id}：docs ${text(named)} 不在，它的帮助页不会有`)
    return []
  }
  if (!inside(dir, folder)) { problems.push(`${id}：docs 要在市场目录里`); return [] }
  const pages: Array<{ name: string, title: string, file: string }> = []
  for (const file of readdirSync(folder).filter(name => name.endsWith('.md')).sort()) {
    const path = join(folder, file)
    const real = realOf(path)
    if (!inside(dir, path) || !real || !inside(dir, real) || real.split(sep).includes('.git')) {
      problems.push(`${id}：帮助页 ${file} 不能从市场里提供（要在市场目录里，且不在 .git 里）`)
      continue
    }
    let body = ''
    try { body = readFileSync(real, 'utf8') } catch { problems.push(`${id}：帮助页 ${file} 读不了`); continue }
    const name = file.slice(0, -3)
    pages.push({ name: `${id}/${name}`, title: docTitle(body, name), file: real })
  }
  return pages
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
  await installDependencies(dir, options.env)
  return { commit: head.stdout.trim(), dir }
}

/**
 * A market's own packages, when it has any: a module may import one (`yaml`, say) and a market brings no `node_modules`
 * of its own. Installed into the market's copy once per commit — a marker beside it says which — so a checkout without
 * them, or a new one, gets them before boardd imports a module that needs them. No network is used when the lockfile says
 * nothing is missing; a failure is said and the market still loads, since a module that needs nothing works without it.
 */
async function installDependencies(dir: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return
  const commit = (await runGit(['rev-parse', 'HEAD'], { cwd: dir, env })).stdout.trim()
  const marker = join(dir, '.boardlab-dependencies')
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === commit && existsSync(join(dir, 'node_modules'))) return
  // A market with nothing to install (only tools to build it with, or none at all) asks its manager for nothing: an
  // install there would fetch a toolchain for a machine that never builds, and can fail on a host that has no network.
  const wanted = wantedPackages(dir)
  if (wanted === 0) { writeFileSync(marker, `${commit}\n`); return }
  const installed = await runPackageManager(dir, env)
  if (installed.code !== 0) { console.error(`${dir}：装市场的依赖失败：${lastLine(installed)}`); return }
  writeFileSync(marker, `${commit}\n`)
}

/** How many runtime packages a market's manifest declares (`dependencies`, not `devDependencies`); null when unclear. */
function wantedPackages(dir: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: unknown }
    const dependencies = raw?.dependencies
    if (dependencies === undefined) return 0
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return null
    return Object.keys(dependencies).length
  } catch { return null }
}

/**
 * Install a market's dependencies: `pnpm --prod` when it has a pnpm lockfile and pnpm is there, else `npm --omit=dev`.
 *
 * The package manager is looked for beside boardd's own Node first — a release carries its Node in `<release>/node/bin`,
 * and a board host has none of its own on PATH — then on the PATH `env` gives. A tool beside this Node is a script, so
 * it runs on this same Node rather than through a shebang the machine may not resolve.
 */
function runPackageManager(dir: string, env?: NodeJS.ProcessEnv): Promise<Run> {
  const prefer: 'pnpm' | 'npm' = existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'
  const found = findTool(prefer, env) ?? findTool('npm', env)
  if (!found) return Promise.resolve({ code: 1, stdout: '', stderr: 'no pnpm or npm beside boardlab\'s node, and none on PATH' })
  const args = found.name === 'pnpm' ? ['install', '--prod', '--no-frozen-lockfile'] : ['install', '--omit=dev', '--no-audit', '--no-fund']
  // A package manager's own scripts run `node` by name (npm's `node-gyp`, a postinstall), and boardd's machine may have
  // no Node on its PATH at all: this Node's directory goes first, so the install runs on the Node that asked for it.
  const path = [...new Set([dirname(process.execPath), ...((env?.PATH ?? '').split(delimiter).filter(Boolean))])].join(delimiter)
  return new Promise<Run>(resolve => {
    execFile(found.command, [...found.prefix, ...args], { cwd: dir, env: { ...env, PATH: path }, maxBuffer: 32 * 1024 * 1024, timeout: 600_000, encoding: 'utf8' },
      (error: Error | null, stdout: string, stderr: string) => {
        const code = error ? (typeof (error as unknown as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0
        resolve({ code, stdout, stderr: stderr || error?.message || '' })
      })
  })
}

/** How to run a package manager: its command and what comes before its arguments. */
interface Found { name: 'pnpm' | 'npm', command: string, prefix: string[] }

/** A package manager beside this Node, else on `env`'s PATH: null when neither has it. */
function findTool(name: 'pnpm' | 'npm', env?: NodeJS.ProcessEnv): Found | null {
  const own = join(dirname(process.execPath), name)
  if (existsSync(own)) return { name, command: process.execPath, prefix: [own] }
  if (existsSync(join(dirname(process.execPath), `${name}.cmd`))) return { name, command: join(dirname(process.execPath), `${name}.cmd`), prefix: [] }
  for (const path of (env?.PATH ?? '').split(delimiter)) if (path && existsSync(join(path, name))) return { name, command: join(path, name), prefix: [] }
  return null
}
