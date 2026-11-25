/**
 * The contract between boardlab and a flasher host backend. boardlab is the registry, gateway and user interface of a
 * set of flasher hosts; a backend is one kind of them: this machine, a rack behind a management controller, a fleet of board hosts. What every backend
 * offers is the same three things, a relay to reset boards, a USB download path and a serial port; the rest is optional
 * and the core offers it only for backends that have it.
 */
import type { BootMark, Channel as WireChannel, DiscoveryContext, DiscoveryMethod, DiscoveryValues, FlashPlan, LabFields, LogRange } from '../shared/types.ts'
import type { ConsoleSession } from './console.ts'
import type { DebugCapability } from './debug.ts'

/** What reaching a backend takes, as entered in its settings. */
export interface LabConfig { url: string, username: string, password: string, jump: string }

/** One board as its backend lists it, or an empty slot: a place for a board that so far has only a console. */
export interface LabDevice {
  /** What boardlab calls it at first: the lab's id and the backend's name for it (`<lab>-<name>`, or `<lab>-<slot
   *  ref>` for an empty slot). A person's rename, or the backend renaming itself, can make it differ afterwards. */
  name: string
  /** How the backend addresses it, when that is not `name` (an empty slot: `<host>/s4`). */
  address?: string
  /** The slot it sits in (`<host>/s3`), for backends whose boards sit in slots. A board swapped, renamed or registered
   * into a slot keeps boardlab's record of the slot: its lock, queue and history. */
  slot?: string | null
  /** A slot with no board registered: only its console is there. */
  empty?: boolean
  /** The board's slot has lost its console (its adapter was unplugged or moved): re-cabled, the host wants a rebuild. */
  slotGone?: boolean
  /**
   * What a reset does for a board whose backend can tell: boot its own media (`reset`, or the name of the backend's
   * way around a strapped download mode), or not (`why`).
   */
  mediaBoot?: { method: string | null, available: boolean, why?: string | null } | null
  model: string | null
  /** The machine in the backend the board is attached to, for backends of several hosts. */
  host?: string | null
  /** The SDKs the backend can boot the board with (see `builds`). */
  sdks?: string[]
  /** The SoC, for a backend that knows it; otherwise boardd guesses it from `model`. */
  soc?: string | null
  /** The backend sees the board's own system running. */
  online: boolean
  serialPort: string | null
  /** The backend's serial reader has the port open; consoles need it. */
  serialConnected: boolean
  /** Its download port, in the `3-2.3` form `fastboot -s usb:` takes. */
  downloadUsbPath: string | null
  /** The backend can debug it (see `debug`): the provider's name, its title and what it offers. */
  debug?: { provider: string, title?: string, kinds: string[] } | null
  ip: string | null
  /** Who holds the board in the backend itself, when that is not boardd (someone using it directly). */
  heldBy?: string | null
  /** What a person is asked to do on the board right now (press RESET, …), for boards reset by hand. */
  attention?: string | null
  /** The backend's id for that request: answering it with the same id twice is answering once. */
  attentionRequest?: string | null
}

/** A board (one of its chips) as a backend addresses it. */
export interface BoardTarget {
  /** The lock target: a board's name, or another target the backend keeps (see `lockTarget`). */
  board: string
  /** The backend's own name for it. */
  device: string
  /** Its lease in the backend, for backends that keep their own (see `lease`). */
  lease: string | null
  /** The chip, and its download port where known. */
  die: string
  usbPath: string | null
  /** The chip's serial port as the backend names it, for backends whose ports boardlab names (a local alias). */
  port: string | null
  /** The token of the input gate the board's lock holds, for backends whose consoles have gates (see `gated`). */
  gate: string | null
}

/** A checked file on boardd, or (with `source: backend`) a URL/absolute path for the board host to resolve. */
export interface BootFile {
  path: string
  /** Empty for a backend source: the board host hashes the content it actually reads. */
  sha256: string
  source?: 'backend'
}
/** How long a RAM boot waits for the download port between files. */
export interface PortTiming { firstMs: number, laterMs: number, waitMs: number }

/** What a backend tells boardd as it happens. */
export type LabNews =
  | { kind: 'ports', host: string, added: string[], removed: string[] }
  | { kind: 'hosts', host: string }

/** A board a scan found: what it suggests calling it, a line for people, and what registering it takes. */
export interface LabFinding { host: string | null, name: string, summary: string, warnings: string[], detail: unknown }
/** One host's ports no board uses: what a new cable shows up as before it is a board. */
export interface LabSlots { host: string, consoles: Array<{ id: string, label: string }>, usb: Array<{ id: string, label: string }> }
/** A board's lease in the backend, held for whoever holds its lock in boardd. */
export interface LabHolder { holder: string, purpose: string, token: string | null }

/**
 * `notice` gets what a person is asked to do while a board reset by hand waits for them, and null once it is done.
 * `request` is the backend's id for that ask, carried to the page and back with the confirmation, so a click that
 * arrives after the backend already saw the board arrive resolves to what it answered instead of failing.
 */
export type Notice = (message: string | null, request?: string | null) => void

/**
 * The relay: restarting boards. `signal` aborts once the lock the restart runs under is released or stolen: a backend
 * still waiting (for a person, say) should give up then.
 */
export interface RelayCapability {
  /**
   * Check that the board can do it and say what will be pressed, for the action log; throws when it cannot. Without it
   * the log names the backend and its device.
   */
  describe?(target: BoardTarget, action: 'reset' | 'download'): string
  reset(config: LabConfig, target: BoardTarget, notice?: Notice, signal?: AbortSignal): Promise<string | void>
  /**
   * Restart the board into its boot ROM's download mode. A backend that only learns which download port is the board's
   * by watching it appear returns that port.
   */
  enterDownload(config: LabConfig, target: BoardTarget, notice?: Notice, signal?: AbortSignal): Promise<string | void>
  /**
   * Tell the backend that the person did what a waiting reset asked of them. `request` names the ask (see `Notice`):
   * the backend answers what that request was, already answered or not, so pressing the page's button twice or after
   * the board was seen is not an error. Without it, the ask waiting for that board now.
   */
  confirm?(config: LabConfig, target: BoardTarget, note: string, request?: string | null): Promise<string>
}

/** What can be done to a channel: relays switch, buttons are pressed; `pulse` and `click` do it for `ms` and undo it. */
export type ChannelAction = 'on' | 'off' | 'toggle' | 'pulse' | 'press' | 'release' | 'click'
export const CHANNEL_ACTIONS: ChannelAction[] = ['on', 'off', 'toggle', 'pulse', 'press', 'release', 'click']

/** One relay, button or line wired to a board, as its relay controller names it (`<board>/reset`, `<board>/power`). */
export interface Channel extends WireChannel { actions: ChannelAction[] }

/**
 * For a backend whose relay controller lets each of a board's lines be worked by hand: beyond reset
 * and download mode, a power relay, a boot strap, a button.
 */
export interface ChannelsCapability {
  list(config: LabConfig, target: BoardTarget): Promise<Channel[]>
  set(config: LabConfig, target: BoardTarget, channel: string, action: ChannelAction, ms: number | null): Promise<string>
}

/** The serial port. */
export interface SerialCapability {
  /** `history: false` skips the backlog when only new output matters, as for input. */
  open(config: LabConfig, target: BoardTarget, options?: { history?: boolean }): Promise<ConsoleSession>
  /** Whether the port is usable right now, for a backend that can tell at once; listed backends say so in their listing. */
  online?(target: BoardTarget): boolean
  /** Its consoles have input gates that follow the lock, so a lock comes with a gate token. */
  gated?: boolean
  /** Its console's log over a time range, searched (see LogQuery); for a backend that keeps logs it can read back. */
  logs?(config: LabConfig, target: BoardTarget, query: LogQuery): Promise<LogRange>
  /**
   * The lines its boards print as a boot starts, beyond the core's (a vendor's ROM banner, its own kernel's): looked
   * for with them. One with a core mark's id takes its place.
   */
  bootMarks?(config: LabConfig, target: BoardTarget): BootMark[] | Promise<BootMark[]>
}

/**
 * What part of a console's log. A search: lines stamped from `since` to `until` (`YYYY-MM-DD HH:MM:SS`, either may be
 * absent), keeping those matching `grep` (text, case-blind; a regex with `regex`), at most `limit`, the last ones unless
 * `first`; with `hits`, only where every match is (`LogRange.hits`, at most `maxHits`), not the lines.
 *
 * With `at`, a window of the log instead, unsearched: `before` lines up to the line at `at`, that line, and `after`
 * lines past it. `at` is a position an earlier answer gave, `line:<n>` for the line numbered n, or `start` / `end` of
 * what the log keeps.
 */
export interface LogQuery {
  since?: string | null, until?: string | null, grep?: string | null, regex?: boolean, limit?: number, first?: boolean
  hits?: boolean, maxHits?: number
  at?: string | null, before?: number, after?: number
  /** Find these boot lines too (`LogRange.marks`), at most `maxMarks`; without `grep`, only them. */
  marks?: BootMark[], maxMarks?: number
  /** Search only from this line number on: a page following a growing log asks only for what is new. */
  fromLine?: number
  /**
   * Where a time range's lines are, not what they say: the answer's `base` is its first line number and `total` how
   * many lines it holds, so a page can draw a log of just that range and read its windows by number. `grep`, `marks`
   * and `at` do not apply.
   *
   * This is not a backend's own capability: core asks the backend for a search over the range with `hits` and one
   * `maxHits`, which every backend that searches its log already answers (a host that indexes its log answers it from
   * the index, reading no lines), and hands back the first number and the count. A backend that cannot give `hits`
   * cannot answer it, and is told so rather than shown a range that is not the one asked for.
   */
  bounds?: boolean
}
export type { LogRange }

/** The USB download path. Loading runs from RAM and never flashes. */
export interface DownloadCapability {
  /** Can fetch HTTP(S) URLs and read absolute paths on its own host during a whole-sequence boot. */
  backendFiles?: boolean
  /** Load a file into RAM through the download port and let it run. `signal` aborts it (see `Backend.cancels`). */
  stage(config: LabConfig, target: BoardTarget, file: BootFile, timeoutMs?: number, signal?: AbortSignal): Promise<string>
  /** Whether the download port is enumerated. */
  present(config: LabConfig, target: BoardTarget): Promise<boolean>
  /**
   * For a backend that can run a whole RAM boot itself: load the files in order, waiting for the download port between
   * them as `timing` says, in one call. Without it boardd stages file by file.
   */
  boot?(config: LabConfig, target: BoardTarget, files: BootFile[], timing: PortTiming, signal?: AbortSignal): Promise<string>
}

/** The boards of a backend that lists them itself; the rest register boards through boardd. */
export interface InventoryCapability {
  verify(config: LabConfig): Promise<string>
  devices(config: LabConfig): Promise<LabDevice[]>
  /**
   * Read the board in a slot again after someone swapped it: identify it and update the backend's record of it, under
   * its lease. `name` renames it, `rename` names it after what was read. Returns its name afterwards. `signal` aborts
   * once that lease is released or stolen.
   */
  refresh?(config: LabConfig, target: BoardTarget, options: { name?: string | null, rename?: boolean }, progress: (line: string) => void, signal?: AbortSignal): Promise<{ device: string, message: string }>
  /** For a backend that keeps a board registry: forget a board there. boardd only asks while nobody holds it. */
  remove?(config: LabConfig, device: string): Promise<void>
}

/**
 * A backend that keeps a board's name itself (a lab's registry, devices named after boards): rename it
 * there too, so the old name is gone from everywhere and the console follows.
 */
export interface RenameCapability {
  /**
   * The backend renames one thing per chip (a local alias) rather than the whole board. boardd calls
   * `rename` once per chip, with `target.die`, and the board is renamed after all of them succeed.
   */
  perChip?: boolean
  /**
   * Rename the backend's record: `target.device` is the old name (here the board's, in a lab the device's, without the
   * lab's prefix) and `to` the new one. Returns the backend's own name for it afterwards (`device`) and, for a
   * per-chip rename, the new serial alias.
   */
  rename(config: LabConfig, target: BoardTarget, to: string): Promise<{ device?: string, alias?: string, message?: string }>
}

/** For a backend with leases of its own: a lease held for every lock on its boards. */
export interface LeaseCapability {
  /**
   * Take or renew the board's lease for the holder of its boardd lock, and return its token. Given the token of the
   * lease boardd already holds, the lease is kept and only renamed to the new holder. boardd calls it when a lock is
   * taken, handed over or stolen, and again at every sync to keep the lease alive.
   */
  take(config: LabConfig, device: string, holder: LabHolder): Promise<string>
  /** Give the lease back once the board has no holder in boardd. */
  give(config: LabConfig, device: string, token: string): Promise<void>
}

/** For a backend that can find boards itself. */
export interface DiscoveryCapability {
  /**
   * The ways this backend can find a board here, each with its own title, about text and fields. Asking for a host or
   * slot lets the backend offer choices for it (that host's ports, the slot it may touch). Empty when it has nothing
   * to offer now.
   */
  methods(config: LabConfig, context: DiscoveryContext): Promise<DiscoveryMethod[]>
  /**
   * Run one of `methods`. It looks only at what no registered board uses, and may reset what is plugged into free
   * lines, so boardd asks a person to confirm first. A backend that registers boards as it finds them calls
   * `registered`; whatever it could not register comes back as findings for a person to apply.
   */
  run(config: LabConfig, method: string, values: DiscoveryValues, context: DiscoveryContext,
    progress: (line: string) => void, registered?: (device: string) => void, signal?: AbortSignal): Promise<{ message: string, found: LabFinding[] }>
  /** Register a board a scan found, under `name` (the backend's own name for it). */
  register(config: LabConfig, finding: LabFinding, name: string): Promise<void>
  /**
   * A board no scan can find — its roles are not USB or a cabled console, so a person says what it is. The method
   * (`compose: true` in its definition, see `DiscoveryMethod`) carries the backend's own fields; `values` are what a
   * person entered, keyed by field id. Registers the board under `values.name` and returns the registered name.
   * Throwing says why it cannot (a missing field, a choice the backend no longer offers).
   */
  compose?(config: LabConfig, method: string, values: DiscoveryValues, context: DiscoveryContext): Promise<{ name: string, message: string }>
  /**
   * Start one host over after it was re-cabled: drop the backend's own record of what is wired to `host` and find
   * its boards again, registering each as found (`registered`), as `discover` does. Boards the backend was told about
   * by hand stay. It resets boards, so boardd runs it only on a person's confirmation while none of that host's boards
   * is held.
   *
   * `keepInUse` (when `keepsInUse` says the backend can): redo only what moved. Boards in use keep their slots and
   * wiring and are never reset; boards whose console is gone are forgotten; free consoles are searched again. boardd
   * then runs it while others hold boards on the host.
   */
  rebuild?(config: LabConfig, host: string, progress: (line: string) => void, registered?: (device: string) => void, options?: { keepInUse: boolean }, signal?: AbortSignal): Promise<{ message: string, found: LabFinding[] }>
  /** `rebuild` can keep the boards in use (`keepInUse`). */
  keepsInUse?: boolean
}

/** For a backend that can tell which of its ports no board uses yet (the choices a registration method may offer). */
export interface PortsCapability {
  /** Each host's serial consoles and download ports no board uses yet. */
  list(config: LabConfig): Promise<LabSlots[]>
}

/**
 * A flash package to write to a board: a `url` the backend fetches itself (in a scheme it says it takes, see
 * `PackageKinds`), or a file on this machine (`path`). `sha256`, when known, is what it must hash to (a backend may
 * use a copy it already has). `flasher` names the backend's tool to write it with; null lets the backend choose.
 * `refresh`: fetch `url` again even when the backend keeps a cached copy of it. `partitions`: write only these of
 * the package's partitions (names as the backend's `plan` gives them); absent, the whole package.
 */
export interface FlashPackage { url?: string, path?: string, sha256?: string | null, flasher?: string | null, refresh?: boolean, partitions?: string[] }

/**
 * Which packages a backend can flash: the URL schemes it fetches (`https`), and the endings of the file names it can
 * write (`.zip`); none listed means any. The core only compares these strings, so a market's image is offered to a
 * board whose backend takes it, and nothing in between knows what a scheme or an archive is.
 */
export interface PackageKinds { schemes: string[], suffixes: string[] }

/** For a backend that knows named builds (SDKs): booting or flashing a board with one, fetching the build itself. */
/**
 * How a long run tells boardd the backend's own name for it (a host's job id), as soon as it has one: a boardd that
 * restarts while the run goes on follows it again by that handle (`Backend.follow`). Core keeps it as it is given.
 */
export interface RunReport { handle(handle: string): void }

export interface BuildsCapability {
  boot(config: LabConfig, target: BoardTarget, build: { sdk: string, method: 'load' | 'download', variant: string | null, brk?: string | null }, progress: (line: string) => void, signal?: AbortSignal, report?: RunReport): Promise<string>
  /** Where an SDK's boot recipe can stop early (`breaker: NAME` in the recipe), for debugging one stage on its own. */
  breaks?(config: LabConfig, sdk: string): Promise<{ load: string[], download: string[] }>
  /**
   * For a backend that can flash a whole package (an image archive its flasher writes to the board's storage): write
   * `pkg` to the board, reporting progress lines (some with `NN%`). `signal` aborts it, for a backend that can stop.
   */
  flash?(config: LabConfig, target: BoardTarget, pkg: FlashPackage, progress: (line: string) => void, signal?: AbortSignal, report?: RunReport): Promise<string>
  /** The packages `flash` takes; without it, http(s) links and files sent to boardd, of any name. */
  accepts?: PackageKinds
  /**
   * What flashing `pkg` would write, without touching the board: its media and their partitions, as the backend reads
   * the package. It may have to fetch the package first (`progress` says so).
   */
  plan?(config: LabConfig, target: BoardTarget, pkg: FlashPackage, progress: (line: string) => void, signal?: AbortSignal): Promise<FlashPlan>
}

export type { FlashMedium, FlashPartition, FlashPlan } from '../shared/types.ts'

/** What a backend's `flash` takes when it does not say. */
export const DEFAULT_PACKAGES: PackageKinds = { schemes: ['http', 'https'], suffixes: [] }

/** Whether a package by this URL (or, with no scheme, a file of this name) is one `kinds` take. */
export function takesPackage(kinds: PackageKinds, url: string | null, name: string): boolean {
  if (url !== null) {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
    if (!scheme || !kinds.schemes.includes(scheme)) return false
  }
  const lower = name.toLowerCase()
  return !kinds.suffixes.length || kinds.suffixes.some(suffix => lower.endsWith(suffix.toLowerCase()))
}

/** For a backend that can tell when things change. */
export interface NewsCapability {
  /** Follow the news until the returned stop is called; `ended` says it stopped by itself, and boardd follows again at its next sync. */
  watch(config: LabConfig, onNews: (news: LabNews) => void, ended: (reason: string) => void): () => void
}

export interface Backend {
  /** What kind of backend this is, shown on the page. */
  kind: string
  /** Which access settings it uses and what they mean to it; one with none has no settings page. */
  fields?: LabFields
  /** A line for the settings page on how its boards are reached. */
  about?: string
  /** The jump host to use when none is set, from the backend's address. */
  defaultJump?(url: URL): string
  /**
   * Lock targets besides boards that the backend keeps (a control slot with no board yet, say): true for one of its own
   * that exists, false for one that is not its kind; throws BoardError('not-found') for one of its kind that is missing.
   */
  lockTarget?(name: string): boolean
  inventory?: InventoryCapability
  relay: RelayCapability
  /** A board's relays and buttons, one by one. */
  channels?: ChannelsCapability
  serial: SerialCapability
  download: DownloadCapability
  lease?: LeaseCapability
  discovery?: DiscoveryCapability
  ports?: PortsCapability
  builds?: BuildsCapability
  /**
   * The operations this backend stops when the signal it was given aborts: boardd then offers a cancel for them
   * (`Busy.cancellable`, `POST /api/cancel`). A backend that stops one by telling its own job to end should keep
   * following that job until it has ended, so the board's state is known, and then throw a `CancelledError`.
   * What boardd runs step by step itself (a RAM boot file by file) stops between steps whatever is listed here.
   */
  cancels?: readonly CancellableOperation[]
  /**
   * Let go of the operation running on a board that boardd is not running itself (one left by a boardd that
   * restarted, a job started outside boardd): it ends soon. When nothing runs there, throw a `BoardError('conflict', …)`
   * that says so (and what ran last): boardd passes it on as it is, not as a board that would not stop.
   */
  cancel?(config: LabConfig, target: BoardTarget): Promise<string>
  /**
   * Follow a run a previous boardd started and reported a handle for (`RunReport`), until it ends: resolve with what it
   * said when it succeeded, throw when it failed (a `CancelledError` when it was cancelled). `signal` aborts when someone
   * cancels it. A backend without this leaves such a run marked interrupted.
   */
  follow?(config: LabConfig, target: BoardTarget, handle: string, progress: (line: string) => void, signal: AbortSignal): Promise<string>
  news?: NewsCapability
  /** A backend whose own record names the board: renaming it there too. */
  rename?: RenameCapability
  /** For a backend whose boards can be debugged (halt/run/regs, a trace channel, an endpoint other tools connect to). */
  debug?: DebugCapability
}

/**
 * The long operations a backend can be asked to stop: restarting (`reset`, `download`), loading (`stage`, a backend's
 * own RAM `boot`), a named build (`build`), a package (`flash`), reading a board again (`refresh`), and finding boards
 * (`discover`, which a rebuild is too).
 */
export type CancellableOperation = 'reset' | 'download' | 'stage' | 'boot' | 'build' | 'flash' | 'refresh' | 'discover'

/** Whether `backend` stops `operation` when its signal aborts. */
export const stops = (backend: Backend, operation: CancellableOperation) => !!backend.cancels?.includes(operation)

/** `user@host` or `user@host:port`, the form of a backend's jump-host setting. */
export const JUMP = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+(:\d{1,5})?$/

/** A device range such as `sub0-* sub1-3`: names or `*` patterns separated by spaces or commas. Empty takes every board. */
export function deviceFilter(text: string | null): (name: string) => boolean {
  const patterns = (text ?? '').split(/[\s,]+/).filter(Boolean)
  if (!patterns.length) return () => true
  const tests = patterns.map(pattern => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\-]/g, '\\$&').replace(/\*/g, '.*')}$`))
  return name => tests.some(test => test.test(name))
}
export const DEVICE_PATTERN = /^[A-Za-z0-9_.*-]+$/
