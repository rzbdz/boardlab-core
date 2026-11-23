/**
 * Image markets: places a module reads flashable images from (a package repository, directories on a build server).
 * A module offers a *driver* (a kind of market) and boardd sets up *markets* of it with their configuration — where a
 * market reads from is never in a module. The core lists a market's folders for the page and the CLI: newest first,
 * filtered to a SoC, cached a minute; what a folder holds, and how an image is fetched, is the driver's.
 */
import type { Market, MarketEntry, MarketListing } from '../shared/types.ts'
import { BoardError } from './errors.ts'
import type { Kernel } from './kernel.ts'

/** An image a market holds, as a board's backend fetches it: `url` in a scheme that backend declares it can take. */
export interface MarketImage { url: string, name: string, sha256?: string | null, size?: number | null }

/** One market, made by its driver from its configuration. */
export interface ImageMarket {
  /** What a folder holds (`''` is the top). Entries' paths are the market's own; the core sorts and filters them. */
  list(path: string, signal?: AbortSignal): Promise<MarketEntry[]>
  /** Where the image at `path` is fetched from, for a flash. */
  locate(path: string, signal?: AbortSignal): Promise<MarketImage>
}

/** A kind of market a module offers: what it is, and how to make one from its configuration (checked there). */
export interface MarketKind {
  kind: string
  title: string
  /** One line on what a market of this kind reads. */
  about: string
  create(config: Record<string, unknown>): ImageMarket
}

/** How a market is set up: its kind, a title for the page, its driver's configuration, and who set it up. */
export interface MarketSetup { kind: string, title?: string | null, config: Record<string, unknown>, source: string }

/** How long a folder's listing is kept before the market is asked again. */
const FRESH_MS = 60_000
const MARKET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

interface Instance { id: string, setup: MarketSetup, market: ImageMarket | null, error: string | null }

export class Markets {
  private readonly kinds = new Map<string, MarketKind>()
  private readonly instances = new Map<string, Instance>()
  private readonly listings = new Map<string, MarketListing & { at: number }>()
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
  async folder(id: string, path: string, options: { soc?: string | null, refresh?: boolean, signal?: AbortSignal } = {}): Promise<MarketListing> {
    const market = this.market(id)
    const at = folderPath(path)
    const key = `${id}\0${at}`
    let listing = this.listings.get(key)
    if (!listing || options.refresh || this.k.now() - listing.at > FRESH_MS) {
      let read = this.reading.get(key)
      if (!read) {
        read = (async () => {
          let entries: MarketEntry[]
          try { entries = await market.list(at, options.signal) }
          catch (error) { throw error instanceof BoardError ? error : new BoardError('hardware', `市场 ${id} 读不出 ${at || '顶层'}：${(error as Error).message}`) }
          const fresh = { market: id, path: at, entries: sortEntries(entries), readAt: this.k.iso(), at: this.k.now() }
          if (this.instances.get(id)?.market === market) this.listings.set(key, fresh)
          return fresh
        })().finally(() => this.reading.delete(key))
        this.reading.set(key, read)
      }
      listing = await read
    }
    const soc = options.soc?.toLowerCase() || null
    const entries = soc ? listing.entries.filter(entry => !entry.soc || entry.soc.toLowerCase() === soc) : listing.entries
    return { market: listing.market, path: listing.path, entries, readAt: listing.readAt }
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
    const kind = this.kinds.get(instance.setup.kind)
    if (!kind) { instance.market = null; instance.error = `没有 ${instance.setup.kind} 这种市场的驱动（装上提供它的模块）`; return }
    try { instance.market = kind.create(instance.setup.config); instance.error = null }
    catch (error) { instance.market = null; instance.error = `设置不对：${(error as Error).message}` }
  }

  private forget(id: string) { for (const key of this.listings.keys()) if (key.startsWith(`${id}\0`)) this.listings.delete(key) }
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
 * Newest first. Folders before images. Folders by name, as versions where they are ones (`v4.0.10` before `v4.0.9`,
 * `v4.0` before `v4.0rc4`) and numeric-aware otherwise (`20261123` before `20261122`). Images by when they changed, then
 * by name the same way.
 */
export function sortEntries(entries: MarketEntry[]): MarketEntry[] {
  const time = (entry: MarketEntry) => entry.modified ? Date.parse(entry.modified) || 0 : 0
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    if (a.kind === 'image') { const t = time(b) - time(a); if (t) return t }
    return compareNames(b.name, a.name)
  })
}
