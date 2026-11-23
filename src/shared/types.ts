/** Wire types shared by boardd, the CLI, the web UI and the DSH plugin. */

/**
 * The HTTP API's version. It goes up only for a change an older client cannot live with; boardd keeps serving older
 * clients for the versions it can, and `GET /api/version` lets a client see what it is talking to.
 */
export const API_VERSION = 1

export type LeaseStatus = 'held' | 'released' | 'stolen'
export type BoardMode = 'unknown' | 'normal' | 'resetting' | 'fastboot'
export type BoardSource = 'import' | 'scan' | 'manual' | 'lab'

export interface Lease {
  id: string
  board: string
  holder: string
  purpose: string
  startedAt: string
  status: LeaseStatus
  endedAt: string | null
  endReason: string | null
}

/** An agent asking a person to let go of a board's lock: shown on the page until the person answers or 60 s run out. */
export interface YieldRequest {
  id: string
  board: string
  /** The agent waiting for it (`claude:…`). */
  holder: string
  purpose: string
  /** The person holding the lock now. */
  owner: string
  at: string
  /** When it stops waiting, as an ISO time. */
  until: string
}

export interface Waiter { id: string, board: string, holder: string, purpose: string, queuedAt: string }

/**
 * What is being done to a board right now (reset, download mode, boot, discovery, …), from when boardd starts it
 * until it ends: every page and client sees the same in-between state, and another operation on the board waits.
 */
export interface Busy {
  /** The run's id (`Run.id`): what a client that lost its connection follows it by. Absent from an older boardd. */
  id?: string
  kind: string
  /** What a person reads: `复位中`, `发现中`. */
  label: string
  by: string
  since: string
  /** The latest progress line, while there is one. */
  line: string | null
  /**
   * Whether it can be stopped (`POST /api/cancel`): the backend doing it says it honours a cancel. A run that cannot
   * be stopped halfway (writing a backend's settings, say) is not.
   */
  cancellable: boolean
}

/**
 * How a run ended: `interrupted` when boardd restarted while it ran and could not follow it to its end (its backend may
 * still be running it).
 */
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

/** One run boardd did to boards (`Busy` while it runs), as its database keeps it. */
export interface Run {
  id: string
  boards: string[]
  kind: string
  label: string
  by: string
  since: string
  /** The latest progress line it showed. */
  line: string | null
  status: RunStatus
  /** Why it failed, was cancelled or interrupted; what it said when it succeeded. */
  message: string | null
  endedAt: string | null
}

export interface Chip {
  board: string
  die: string
  serialPath: string | null
  baud: number
  alias: string | null
  downloadUsbPath: string | null
  usbId: string | null
  lastSeenAt: string | null
  /** The backend has a live connection to this port. */
  online: boolean
  /** Why the backend's input gate does not follow the board's lock, when it does not. */
  gateError: string | null
}

export interface Board {
  name: string
  slot: number | null
  serial: string | null
  product: string | null
  baseMac: string | null
  soc: string | null
  notes: string | null
  source: BoardSource
  mode: BoardMode
  chips: Chip[]
  lease: Lease | null
  waiters: Waiter[]
  /** What boardd is doing to it right now. */
  busy: Busy | null
  /** The board's current or last run, with how it ended: kept after it ends and across a restart of boardd. */
  run?: Run | null
  lastSeenAt: string | null
  /** The backend instance the board is on: `local` (this machine), or a lab's id. */
  backend: string
  /**
   * The slot it sits in, a second name for it: `slot:5` on this machine, `<lab>/<host>/s3` in a lab. Any command takes
   * it in place of the board's name (`<host>/s3` when no other lab has that host), and a board swapped into the slot
   * keeps the slot's lock, queue and history.
   */
  slotRef: string | null
  /** Set for a board a backend lists itself (a lab): which lab, its own name for the board, and what it says now. */
  lab: BoardInLab | null
}

export interface BoardInLab {
  id: string
  device: string
  /** The lab sees the board's own system running, as of its last listing. */
  online: boolean
  ip: string | null
  /** Someone holds the board in the lab itself, outside boardd; locking waits until they let go. */
  heldBy: string | null
  /** Why the lab's own lease does not follow the board's lock, when it does not. */
  leaseError: string | null
  /** A person is asked to act on the board (press RESET, …); `boards confirm` tells the lab it is done. */
  attention: string | null
  /** The lab's own id for that ask: `confirm` sends it back, so a click after the lab saw the result is harmless. */
  attentionRequest: string | null
  canConfirm: boolean
  /** A slot in the lab with no board registered yet: only its console is there (discover or bind the board). */
  empty: boolean
  /** Its slot's console is gone (adapter unplugged or moved): if the host was re-cabled, rebuild it. */
  slotGone: boolean
  /** The lab can read the board in its slot again after a swap (`boardlab refresh`). */
  canRefresh: boolean
  /**
   * Whether a reset boots the board's own media: `reset` when its download mode is not strapped, the name of the
   * lab's way around the strap when it has one, or null with `why` when a reset leaves it in download mode.
   */
  mediaBoot: { method: string | null, available: boolean, why: string | null } | null
  /** SDKs the lab can boot the board with (`boardlab boot --sdk`), and the line a running one last reported. */
  sdks: string[]
  progress: string | null
  /** The lab can flash the board with a package from a link or a file sent to boardd (`boardlab flash <board> <url|file>`). */
  canFlashPackage: boolean
  /** Which packages it can flash (link schemes, file name endings; none listed is any), when it can. */
  packages: { schemes: string[], suffixes: string[] } | null
  /** The lab can say what a package would write before it flashes it (`boardlab flash --plan`). */
  canPlan?: boolean
  /** The lab can debug it (see `debug`): the provider's name, its title and what it offers. */
  debug?: { provider: string, title?: string, kinds: string[] } | null
}

/** A remote lab boardd can use. Its boards are listed from the lab once it is enabled; its password is write-only. */
/** One of a lab's access settings as its driver uses it. */
export interface LabField { label: string, placeholder: string | null, required: boolean }
/** The access settings a lab's driver uses, by key; keys it leaves out are hidden. */
export type LabFields = Partial<Record<'url' | 'username' | 'password' | 'jump', LabField>>

export interface LabSettings {
  id: string
  kind: string
  /** The kind it was added as at runtime (it can be removed); null for one boardd's configuration names. */
  addedAs: string | null
  /** What is being done to the lab itself right now (its module installing it, say): `Kernel.doing` on `lab:<id>`. */
  busy: Busy | null
  /** What using the lab involves, from its driver. */
  about: string
  fields: LabFields
  /** The lab can look for new boards itself (`discoverLab`), and forget boards (`removeBoard`). */
  canDiscover: boolean
  /** It can start a host's wiring over after re-cabling (forget its boards and slots, find them all again). */
  canRebuild: boolean
  /** It can rediscover a host: keep the boards in use, forget the ones whose console is gone, search the free consoles. */
  canRediscover: boolean
  canRemove: boolean
  /** The lab can say which of its ports no board uses yet (`labSlots`): what a registration method's choices come from. */
  canListPorts: boolean
  /** The lab's relay controller works a board's relays and buttons one by one (`/api/relay`). */
  canRelay: boolean
  /** The lab's machines its boards are on, as of its last listing. */
  hosts: string[]
  /** The latest line of a discovery that is running, or how the last one ended. */
  discovery: { running: boolean, line: string, at: string } | null
  enabled: boolean
  url: string | null
  username: string | null
  hasPassword: boolean
  /** The jump host as set, and the one used when it is not. */
  jump: string | null
  defaultJump: string | null
  /** Which of the lab's boards to list: names or `*` patterns; empty lists them all. */
  devices: string | null
  verifiedAt: string | null
  verifyOk: boolean | null
  verifyMessage: string | null
  syncedAt: string | null
  syncOk: boolean | null
  syncMessage: string | null
}

export interface Action {
  id: number
  at: string
  actor: string
  board: string | null
  kind: string
  detail: string | null
  ok: boolean
  message: string | null
}

/** A firmware file boardd ships in firmware/, listed in its firmware.json. */
export interface Firmware { soc: string, purpose: string, path: string, sha256: string, note: string | null }

/** A proposed inventory change supplied by a distribution module. */
export type ProposalKind = string
export interface Proposal {
  id: string
  scanId: string
  kind: ProposalKind
  board: string | null
  slot: number | null
  summary: string
  change: Record<string, unknown>
  status: 'pending' | 'applied' | 'rejected'
}

/** A module boardd has loaded. */
export interface ModuleInfo { id: string, title: string }

/**
 * boardd found its database damaged when it started and put a copy in its place (or, with no good copy, started empty):
 * what changed after that copy is gone. Reported in the state until someone acknowledges it.
 */
export interface DatabaseRestore {
  /** When boardd found the file damaged. */
  at: string
  /** The copy it put in its place, or null when no copy was good and it started with an empty database. */
  backup: string | null
  /** Where the damaged file was moved. */
  aside: string
  /** What the check said of it. */
  reason: string
}

/** The whole picture. Modules add their own fields through the generic state-extension hook. */
export interface State {
  boards: Board[]
  labs: LabSettings[]
  firmware: Firmware[]
  proposals: Proposal[]
  modules: ModuleInfo[]
  you: string
  now: string
  /** Agents waiting for a person to let go of a board they are using. */
  yields: YieldRequest[]
  /** A restore of boardd's database nobody has acknowledged yet (`POST /api/database/acknowledge`), or null. */
  restored?: DatabaseRestore | null
  /** The image markets set up (see `Market`). */
  markets: Market[]
}

/**
 * An image market: somewhere a module reads flashable images from (a repository, directories on a server), set up
 * with what its driver needs. Its driver says what it is; where it reads from is configuration.
 */
export interface Market {
  id: string
  /** The driver's kind, and its title and one line on it. */
  kind: string
  kindTitle: string
  about: string
  /** The name this market goes by on the page. */
  title: string
  /** Who set it up (a module's id, `site`), for people to know where to change it. */
  source: string
}

/** One entry of a market's folder: a folder to open, or an image. `path` is the market's own, `/`-separated. */
export interface MarketEntry {
  path: string
  name: string
  kind: 'folder' | 'image'
  /** The SoC the market files it under, when it knows; null for one it does not (shown for every SoC). */
  soc: string | null
  size?: number | null
  sha256?: string | null
  /** ISO time it was last changed, when the market knows. */
  modified?: string | null
  /** The market's own words on it (`构建 20261116`), shown beside the name. */
  note?: string | null
  /**
   * Where the market wants it in its folder, for entries that are places it was set up with rather than things it
   * found (a configured directory): lower first, before any entry without one; the rest stay newest first.
   */
  order?: number | null
}

/** A market folder as boardd lists it: newest first, with when it was read (a minute's cache; `refresh` reads again). */
export interface MarketListing { market: string, path: string, entries: MarketEntry[], readAt: string }

/**
 * A board an image could be flashed onto: whether it is the caller's already (`mine`), free to lock, or why not. Only
 * boards whose backend takes the image and whose SoC is the image's (or either is unknown) are listed.
 */
export interface MarketTarget { board: string, soc: string | null, mine: boolean, free: boolean, why: string | null }

/** One partition a package writes (or could): where it goes on its medium, and the image it is written from. */
export interface FlashPartition {
  name: string
  /** Bytes from the start of the medium, and the partition's size; null where the table leaves it open (the rest). */
  offset: number | null
  size: number | null
  /** The file in the package it is written from, and that file's size; null for a partition the package does not write. */
  image: string | null
  payload: number | null
  /** It can be chosen on its own (`FlashPackage.partitions`). */
  selectable: boolean
}

/** A medium a package lays out (a NOR flash, a disk), in the backend's own words. */
export interface FlashMedium { id: string, label: string, size: number | null, partitions: FlashPartition[] }

/**
 * What a package would write, as its board's backend reads it. `partial`: the backend can write only some partitions;
 * `notes`: what the reader should know (a layout chosen only once the board is seen, say), in the backend's words.
 */
export interface FlashPlan { package: string, media: FlashMedium[], partial: boolean, notes: string[] }

/** A relay, button or line wired to a board, as its backend's relay controller names it (`<board>/power`). */
export interface Channel {
  id: string
  /** Its role on the board (`reset`, `power`, `boot`). */
  label: string
  /** `relay`, `button` or `gpio`. */
  kind: string
  /** As the controller reads it now (`on`, `off`, `pressed`, …), when it can. */
  state: string | null
  /** What can be done to it: `on`, `off`, `toggle`, `pulse` (relays), `press`, `release`, `click` (buttons). */
  actions: string[]
}
export interface BoardChannels { board: string, supported: boolean, channels: Channel[] }

export interface BoardDetail { board: Board, actions: Action[], leases: Lease[] }

/** One way to debug a board, as its backend reports it (see `core/debug.ts` for the contract). */
export interface DebugPath {
  provider: string
  title?: string
  about?: string
  /** What it offers: `halt`, `run`, `reset`, `step`, `regs`, `trace`, `gdb`, `write`. */
  kinds: string[]
  running: boolean
  endpoint?: string | null
  state?: Array<{ label: string, value: string }>
}
/** What a debug action answered: a line for people and, when it has them, label/value pairs (registers, a state). */
export interface DebugResult { message: string, data?: Array<{ label: string, value: string }> }

/** Opaque input-gate capability supplied by a backend; boardd uses it for its own input. */
export interface LockResult { lease: Lease | null, token: string | null, gateToken: string | null, queued: { position: number } | null }
export interface SendResult { output: string, matched: boolean }

/** Events pushed on /api/events. Console bytes use /api/console. */
export type CoreEvent =
  | { type: 'changed', board: string | null }
  | { type: 'lease-stolen', board: string, from: string, by: string, reason: string }
  | { type: 'lease-granted', board: string, holder: string }
  /** A lab's free ports were asked for again, or changed. */
  | { type: 'lab-ports', lab: string, host?: string, added?: string[], removed?: string[] }
  /** A person is asked to act on a board (press RESET, …), or no longer is (message null). */
  | { type: 'attention', board: string, message: string | null, request?: string | null, holder: string | null }

/** Modules may define additional event names and payloads without changing core. */
export type BoardEvent = CoreEvent | ({ type: string } & Record<string, unknown>)

/** A lab host's ports that no board uses yet. */
export interface LabSlots { host: string, consoles: Array<{ id: string, label: string }>, usb: Array<{ id: string, label: string }> }

/** One input a backend's discovery method needs; a choice's options are the backend's own. */
export interface DiscoveryField {
  id: string
  label: string
  kind: 'text' | 'choice'
  placeholder?: string | null
  initial?: string | null
  required?: boolean
  note?: string | null
  options?: Array<{ value: string, label: string }>
}

/** A way a backend can find a board, reported by the backend: text and fields travel with it, core does not know it. */
export interface DiscoveryMethod {
  id: string
  title: string
  about: string
  fields?: DiscoveryField[]
  /**
   * A board a person describes rather than one a scan found: its roles are neither USB nor a cabled console (a debug
   * path bit-banged on header pins, say), so the backend's `compose` registers it from the fields. A page lists it
   * with the ways to add a board instead of with the scans, and need not ask anyone to confirm a hardware reset.
   */
  compose?: boolean
}

/** What the page knows when it asks for methods: one host, or one empty slot on it. */
export interface DiscoveryContext { host?: string | null, slot?: string | null }

/** A method's field values, by field id. */
export type DiscoveryValues = Record<string, string>

/** A lab's free ports as boardd last heard them: shown at once, refreshed in the background. */
export interface LabPorts { hosts: LabSlots[], at: string | null, refreshing: boolean, error: string | null }
