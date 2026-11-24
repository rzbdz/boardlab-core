/**
 * Image markets: places a module reads flashable images from (a package repository, directories on a build server).
 * A module offers a *driver* (a kind of market) and boardd sets up *markets* of it with their configuration — where a
 * market reads from is never in a module. The core lists a market's folders for the page and the CLI: newest first,
 * filtered to a SoC, cached a minute; what a folder holds, and how an image is fetched, is the driver's.
 */
import type { Board, Market, MarketEntry, MarketListing, MarketSearch, MarketTarget } from '../shared/types.ts'
import { takesPackage } from './backend.ts'
import { BoardError } from './errors.ts'
import type { Kernel } from './kernel.ts'

/** An image a market holds, as a board's backend fetches it: `url` in a scheme that backend declares it can take. */
export interface MarketImage { url: string, name: string, sha256?: string | null, size?: number | null }

/** What a driver's search found: its entries, and whether it had to stop short (then an image may be missing). */
export interface MarketFound { entries: MarketEntry[], partial?: boolean }

/** One market, made by its driver from its configuration. */
export interface ImageMarket {
  /** What a folder holds (`''` is the top). Entries' paths are the market's own; the core sorts and filters them. */
  list(path: string, signal?: AbortSignal): Promise<MarketEntry[]>
  /** Where the image at `path` is fetched from, for a flash. */
  locate(path: string, signal?: AbortSignal): Promise<MarketImage>
  /**
   * The link scheme its images are fetched by (`https`, `ssh`), when it is the same for all of them: then a listing for a
   * board says which images that board's backend cannot take without locating each one.
   */
  scheme?: string
  /**
   * Find images by name, when the place a market reads from can search it faster than it can be listed (an index of
   * its files, say): the images whose name has `text`, in their place in the tree — the folders they are in, and the
   * folders above those — so the answer reads as the tree does. A driver whose search can stop short says so with
   * `partial`, and the answer says an image may be missing; the bare entries mean it searched everything.
   * Without it, a search reads every folder.
   */
  search?(text: string, signal?: AbortSignal): Promise<MarketEntry[] | MarketFound>
}

/** A kind of market a module offers: what it is, and how to make one from its configuration (checked there). */
export interface MarketKind {
  kind: string
  title: string
  /** One line on what a market of this kind reads. */
  about: string
  create(config: Record<string, unknown>): ImageMarket
}

/**
 * How a market is set up: its kind, a title for the page, its driver's configuration, and who set it up. `problem`: what
 * its source found wrong before any driver saw it (a file it could not read): the market is listed with it, unusable.
 */
export interface MarketSetup { kind: string, title?: string | null, config: Record<string, unknown>, source: string, problem?: string | null }

/** How long a folder's listing is kept before the market is asked again. */
const FRESH_MS = 60_000
/** How many folders a search reads, and how long it may take: past either it says the tree was not read whole. */
const SEARCH_FOLDERS = 5000
const SEARCH_MS = 30_000
/** How many folders a search reads at once: a market over the network is mostly waiting for each answer. */
const SEARCH_AT_ONCE = 6
const MARKET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

interface Instance { id: string, setup: MarketSetup, market: ImageMarket | null, error: string | null }

export class Markets {
  private readonly kinds = new Map<string, MarketKind>()
  private readonly instances = new Map<string, Instance>()
  private readonly listings = new Map<string, MarketListing & { at: number }>()
  /** Searches already answered, kept a minute like a folder (the same words, SoC and board), so typing on is cheap. */
  private readonly searches = new Map<string, { found: MarketSearch, at: number }>()
  /** Folders being read now: a second ask waits for the same read. */
  private readonly reading = new Map<string, Promise<MarketListing & { at: number }>>()

  constructor(private readonly k: Kernel) {}

  /** A module offers a kind of market; markets of it set up before are made now. */
  offer(kind: MarketKind) {
    if (this.kinds.has(kind.kind)) throw new Error(`market kind ${kind.kind} is offered twice`)
    this.kinds.set(kind.kind, kind)
    for (const instance of this.instances.values()) if (instance.setup.kind === kind.kind) this.make(instance)
  }

  /**
   * Set a market up (or again, with new configuration). A kind nobody offers yet, or a configuration its driver
   * refuses, leaves the market listed with what is wrong, so the page can say it.
   */
  configure(id: string, setup: MarketSetup) {
    if (!MARKET_ID.test(id)) throw new BoardError('invalid', `市场名只能用字母、数字、- 和 _：${id}`)
    const instance: Instance = { id, setup, market: null, error: null }
    this.instances.set(id, instance)
    this.make(instance)
    this.forget(id)
    this.k.changed(null)
  }

  /** Take down the markets `source` set up that are not in `keep` (a source re-reading its configuration). */
  retain(source: string, keep: string[]) {
    for (const instance of [...this.instances.values()]) {
      if (instance.setup.source === source && !keep.includes(instance.id)) { this.instances.delete(instance.id); this.forget(instance.id) }
    }
    this.k.changed(null)
  }

  /** The markets set up, as the page shows them. */
  list(): Array<Market & { error: string | null }> {
    return [...this.instances.values()].map(({ id, setup, error }) => {
      const kind = this.kinds.get(setup.kind)
      return { id, kind: setup.kind, kindTitle: kind?.title ?? setup.kind, about: kind?.about ?? '', title: setup.title || id, source: setup.source, error }
    })
  }

  /**
   * What a folder of a market holds: folders first, then images, each newest first; only entries for `soc` (and those
   * the market files under no SoC) when one is given. A listing younger than a minute is not read again unless `refresh`.
   */
  async folder(id: string, path: string, options: { soc?: string | null, refresh?: boolean, signal?: AbortSignal, board?: Board | null } = {}): Promise<MarketListing> {
    const market = this.market(id)
    const listing = await this.read(id, market, folderPath(path), options)
    return this.shape(market, listing, options)
  }

  /**
   * A market searched: every folder of it read (up to `SEARCH_FOLDERS` and `SEARCH_MS`, whichever ends first — then
   * `partial` says the whole tree was not read), and only the images whose name has `text` and the folders leading to
   * them. A folder with no matching image below it is not in the answer, and neither is a folder whose name matches:
   * what is listed is what can be flashed, already in its place in the tree. The page shows the result expanded.
   */
  async search(id: string, text: string, options: { soc?: string | null, board?: Board | null, refresh?: boolean, signal?: AbortSignal } = {}): Promise<MarketSearch> {
    const market = this.market(id)
    const words = text.trim().toLowerCase()
    if (!words) throw new BoardError('invalid', '搜索要写几个字')
    const key = `${id}\0${words}\0${options.soc?.toLowerCase() ?? ''}\0${options.board?.name ?? ''}`
    const had = this.searches.get(key)
    if (had && !options.refresh && this.k.now() - had.at <= FRESH_MS) return had.found
    if (market.search) {
      let answer: MarketEntry[] | MarketFound
      // In the order the driver gives: a search answer reads in the tree's order (a folder, then what is in it),
      // which sorting by kind would break.
      try { answer = await market.search(words, options.signal) }
      catch (error) {
        if (error instanceof BoardError) throw error
        throw new BoardError('hardware', `市场 ${id} 搜索失败：${(error as Error).message}`)
      }
      const entries = Array.isArray(answer) ? answer : answer.entries
      const found = this.shapeFolders(id, words, market, entries, options, { by: 'index', partial: !Array.isArray(answer) && !!answer.partial, read: 0 })
      if (this.instances.get(id)?.market === market) this.searches.set(key, { found, at: this.k.now() })
      return found
    }
    const deadline = this.k.now() + SEARCH_MS
    let folders = 0, partial = false
    // One folder at a time: the folders below `at` that lead to a matching image, each followed by what is in it, in
    // the tree's own order. Siblings are read side by side (up to SEARCH_AT_ONCE), a market over the network being
    // mostly waiting; `state` is told of the progress and of a stop.
    const walk = async (at: string): Promise<MarketEntry[]> => {
      if (folders >= SEARCH_FOLDERS || this.k.now() >= deadline || state.stopped) { partial = true; return [] }
      folders++
      let listing: MarketListing
      try { listing = await this.read(id, market, at, options) }
      catch (error) {
        if (!at) throw error
        // A folder that cannot be read now (gone since it was listed, say) is skipped, and so is what was under it:
        // the rest of the market is still read (the answer says it was not whole).
        partial = true
        return []
      }
      const own: MarketEntry[] = [], below: Array<{ entry: MarketEntry, kept: MarketEntry[] }> = []
      for (const entry of listing.entries) {
        if (entry.kind === 'folder') { below.push({ entry, kept: [] }); continue }
        if (!entry.name.toLowerCase().includes(words)) continue
        const [shaped] = this.shape(market, { ...listing, entries: [entry] }, options).entries
        if (shaped) own.push(shaped)
      }
      // The folder's images first, then each folder with what is in it, each after the one before it.
      const results: MarketEntry[][] = [own]
      await this.parallel(below.map(item => () => walk(item.entry.path).then(kept => { item.kept = kept }, error => { if (!at) throw error; partial = true })))
      for (const item of below) if (item.kept.length) results.push([item.entry, ...item.kept])
      return results.flat()
    }
    const state = { stopped: false }
    let entries: MarketEntry[] = []
    if (options.signal) options.signal.addEventListener('abort', () => { state.stopped = true }, { once: true })
    try { entries = await walk('') } catch (error) { throw error instanceof BoardError ? error : new BoardError('hardware', `市场 ${id} 搜索失败：${(error as Error).message}`) }
    // The walk's answer says how many folders it read; what it found is shaped as a driver's answer is.
    const found = this.shapeFolders(id, words, market, entries, options, { by: 'folders', partial, read: folders })
    // A search stopped because its page went away is nobody's answer: it is not kept for the next person with the same
    // words, who would be told it was not whole.
    if (this.instances.get(id)?.market === market && !options.signal?.aborted) this.searches.set(key, { found, at: this.k.now() })
    return found
  }

  /**
   * A driver's search answer as the core gives it: its images kept by the SoC and refused for a board as a listing's
   * are, and a folder kept only while a kept image is still below it — a folder's own SoC is its prefix's, not what was
   * found in it, so folders are never dropped for their SoC alone. The answer reads in the tree's order, as given.
   */
  private shapeFolders(id: string, text: string, market: ImageMarket, entries: MarketEntry[], options: { soc?: string | null, board?: Board | null }, found: { by: MarketSearch['by'], partial: boolean, read: number }): MarketSearch {
    const soc = options.soc?.toLowerCase() || null
    const board = options.board
    // The leaves kept, by path, and every folder above them.
    const kept = new Map<string, MarketEntry>(), above = new Set<string>()
    for (const entry of entries) {
      if (entry.kind !== 'image') continue
      if (soc && entry.soc && entry.soc.toLowerCase() !== soc) continue
      kept.set(entry.path, board ? { ...entry, refused: refusal(board, market.scheme ?? null, entry.name) } : entry)
      const parts = entry.path.split('/').slice(0, -1)
      for (let i = 1; i <= parts.length; i++) above.add(parts.slice(0, i).join('/'))
    }
    // In the order given, a folder only where a kept image is below it.
    const shaped = entries.flatMap(entry => entry.kind === 'image' ? (kept.has(entry.path) ? [kept.get(entry.path)!] : []) : above.has(entry.path) ? [entry] : [])
    // How much was searched: the folders read of the tree, or the images the market's index gave.
    return { market: id, text, entries: shaped, folders: found.by === 'folders' ? found.read : kept.size, partial: found.partial, by: found.by, readAt: this.k.iso() }
  }

  /** Run these, `SEARCH_AT_ONCE` at a time; the first failure rejects the rest of the batch. */
  private async parallel(tasks: Array<() => Promise<void>>): Promise<void> {
    let next = 0
    const worker = async () => { while (next < tasks.length) { const task = tasks[next++]!; await task() } }
    await Promise.all(Array.from({ length: Math.min(SEARCH_AT_ONCE, tasks.length) }, worker))
  }

  /**
   * A folder as it was read (sorted, with when): the minute's cache, shared by asks while it is being read. A read is
   * shared with an ask that can be stopped only by the ask itself: two searches waiting on one read must not let one
   * of them being stopped fail the other's.
   */
  private async read(id: string, market: ImageMarket, at: string, options: { refresh?: boolean, signal?: AbortSignal }): Promise<MarketListing & { at: number }> {
    const key = `${id}\0${at}`
    let listing = this.listings.get(key)
    if (!listing || options.refresh || this.k.now() - listing.at > FRESH_MS) {
      const shared = !options.signal
      let read = shared ? this.reading.get(key) : undefined
      if (!read) {
        read = (async () => {
          let entries: MarketEntry[]
          try { entries = await market.list(at, options.signal) }
          catch (error) { throw error instanceof BoardError ? error : new BoardError('hardware', `市场 ${id} 读不出 ${at || '顶层'}：${(error as Error).message}`) }
          const fresh = { market: id, path: at, entries: sortEntries(entries), readAt: this.k.iso(), at: this.k.now() }
          if (this.instances.get(id)?.market === market) this.listings.set(key, fresh)
          return fresh
        })().finally(() => { if (shared) this.reading.delete(key) })
        if (shared) this.reading.set(key, read)
      }
      listing = await read
    }
    return listing
  }

  /** A listing as an answer: the SoC's entries (and those filed under none), each image refused for a board. */
  private shape(market: ImageMarket, listing: MarketListing, options: { soc?: string | null, board?: Board | null }): MarketListing {
    const soc = options.soc?.toLowerCase() || null
    let entries = soc ? listing.entries.filter(entry => !entry.soc || entry.soc.toLowerCase() === soc) : listing.entries
    const board = options.board
    if (board) entries = entries.map(entry => entry.kind !== 'image' ? entry : { ...entry, refused: refusal(board, market.scheme ?? null, entry.name) })
    return { market: listing.market, path: listing.path, entries, readAt: listing.readAt }
  }

  /**
   * The boards `holder` could flash the image at `path` onto: those whose backend takes it and whose SoC is the
   * image's (either unknown counts as a match), theirs first, then free ones, then the rest with why not.
   */
  async targets(id: string, path: string, holder: string, boards: Board[], signal?: AbortSignal): Promise<MarketTarget[]> {
    const at = folderPath(path)
    const image = await this.locate(id, at, signal)
    const parent = at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : ''
    const entry = (await this.folder(id, parent, { signal })).entries.find(item => item.path === at)
    const soc = entry?.soc?.toLowerCase() ?? null
    const out: MarketTarget[] = []
    for (const board of boards) {
      const kinds = board.lab?.packages
      if (!kinds || !takesPackage(kinds, image.url, image.name)) continue
      if (soc && board.soc && board.soc.toLowerCase() !== soc) continue
      const mine = board.lease?.holder === holder
      const why = mine ? (board.busy ? `正在${board.busy.label}` : null)
        : board.lease ? `${board.lease.holder} 在用` : board.lab?.heldBy ? `${board.lab.heldBy} 在实验室里占着` : board.busy ? `正在${board.busy.label}` : null
      out.push({ board: board.name, soc: board.soc, mine, free: !mine && !why, why })
    }
    const rank = (target: MarketTarget) => target.mine && !target.why ? 0 : target.free ? 1 : 2
    return out.sort((a, b) => rank(a) - rank(b) || a.board.localeCompare(b.board))
  }

  /** Where an image of a market is fetched from. */
  async locate(id: string, path: string, signal?: AbortSignal): Promise<MarketImage> {
    const at = folderPath(path)
    if (!at) throw new BoardError('invalid', '要给镜像在市场里的路径')
    try { return await this.market(id).locate(at, signal) }
    catch (error) { throw error instanceof BoardError ? error : new BoardError('hardware', `市场 ${id} 找不到 ${at}：${(error as Error).message}`) }
  }

  private market(id: string): ImageMarket {
    const instance = this.instances.get(id)
    if (!instance) throw new BoardError('not-found', `没有镜像市场 ${id}（有：${[...this.instances.keys()].join('、') || '（无）'}）`)
    if (!instance.market) throw new BoardError('invalid', `镜像市场 ${id} 用不了：${instance.error ?? '没有它的驱动'}`)
    return instance.market
  }

  private make(instance: Instance) {
    if (instance.setup.problem) { instance.market = null; instance.error = instance.setup.problem; return }
    const kind = this.kinds.get(instance.setup.kind)
    if (!kind) { instance.market = null; instance.error = `没有 ${instance.setup.kind} 这种市场的驱动（装上提供它的模块）`; return }
    try { instance.market = kind.create(instance.setup.config); instance.error = null }
    catch (error) { instance.market = null; instance.error = `设置不对：${(error as Error).message}` }
  }

  private forget(id: string) {
    for (const key of this.listings.keys()) if (key.startsWith(`${id}\0`)) this.listings.delete(key)
    for (const key of this.searches.keys()) if (key.startsWith(`${id}\0`)) this.searches.delete(key)
  }
}

/** Why `board` cannot take an image by this name fetched by `scheme` (unknown: the name alone decides), or null when it can. */
function refusal(board: Board, scheme: string | null, name: string): string | null {
  const kinds = board.lab?.packages
  if (!kinds) return `${board.name} 不能用刷机包刷机`
  return takesPackage(kinds, scheme ? `${scheme}://` : null, name) ? null
    : `${board.name} 的后端刷不了这种包（收 ${kinds.schemes.join('、') || '任何'} 链接${kinds.suffixes.length ? `、${kinds.suffixes.join(' ')} 文件` : ''}）`
}

/** A market path as the core passes it on: `/`-separated, no leading or trailing `/`, no `.` or `..` steps. */
export function folderPath(path: string): string {
  const parts = String(path ?? '').split('/').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..' || /[\x00-\x1f]/.test(part))) throw new BoardError('invalid', `市场路径不对：${path}`)
  return parts.join('/')
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** Pre-release words, oldest first: a version with one of these is older than the same version without. */
const STAGES = ['dev', 'alpha', 'a', 'beta', 'b', 'pre', 'preview', 'rc']
/**
 * `v4.0.8`, `v4.0rc4`, `1.2-beta.3`, `release-2.1`: leading text, a version (`v` and numbers, or dotted numbers; a bare
 * number such as a date is not one), then an optional stage and its number.
 */
const VERSION = /^(.*?)(v\d+(?:\.\d+)*|\d+(?:\.\d+)+)(?:[-_.~]?(dev|alpha|a|beta|b|pre|preview|rc)[-_.]?(\d*))?$/i

/**
 * Two names, newer first in the order: as versions when both are one under the same leading text (so `v4.0.8` is newer
 * than `v4.0`, which is newer than `v4.0rc4`, newer than `v4.0beta3`), else numeric-aware (`20261123` before `20261122`).
 */
export function compareNames(a: string, b: string): number {
  const x = VERSION.exec(a), y = VERSION.exec(b)
  if (x && y && x[1]!.toLowerCase() === y[1]!.toLowerCase()) {
    const p = x[2]!.replace(/^v/i, '').split('.').map(Number), q = y[2]!.replace(/^v/i, '').split('.').map(Number)
    for (let i = 0; i < Math.max(p.length, q.length); i++) { const d = (p[i] ?? -1) - (q[i] ?? -1); if (d) return d }
    const stage = (m: RegExpExecArray) => m[3] ? STAGES.indexOf(m[3].toLowerCase()) : STAGES.length
    const d = stage(x) - stage(y)
    if (d) return d
    const n = Number(x[4] || 0) - Number(y[4] || 0)
    if (n) return n
  }
  return collator.compare(a, b)
}

/**
 * Newest first. Folders before images. Entries a market gives an `order` (places it was set up with) first, in that
 * order. Folders by name, as versions where they are ones (`v4.0.10` before `v4.0.9`,
 * `v4.0` before `v4.0rc4`) and numeric-aware otherwise (`20261123` before `20261122`). Images by when they changed, then
 * by name the same way.
 */
export function sortEntries(entries: MarketEntry[]): MarketEntry[] {
  const time = (entry: MarketEntry) => entry.modified ? Date.parse(entry.modified) || 0 : 0
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    // A market's own order for the places it was set up with comes before any order by name or time.
    const placed = (entry: MarketEntry) => typeof entry.order === 'number' ? entry.order : Infinity
    if (placed(a) !== placed(b)) return placed(a) - placed(b)
    if (a.kind === 'image') { const t = time(b) - time(a); if (t) return t }
    return compareNames(b.name, a.name)
  })
}
