/** Wire types shared by boardd, the CLI, the web UI and the DSH plugin. */

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

export interface Waiter { id: string, board: string, holder: string, purpose: string, queuedAt: string }

export interface Chip {
  board: string
  die: string
  serialPath: string | null
  baud: number
  alias: string | null
  downloadUsbPath: string | null
  usbId: string | null
  lastSeenAt: string | null
  /** serial-mux has a daemon for the alias with a device bound; consoles and input need it. */
  online: boolean
  /** Why this port's serial-mux input gate does not follow the board's lock, when it does not. */
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
}

/**
 * A control slot on this machine, driven by its kind's slot driver. `ha` slots are buttons on the Home Assistant
 * controller and follow it on their own; `script` slots run shell scripts entered on the page, for anything else that
 * can power-cycle a board (a smart plug, say).
 */
export interface Slot {
  slot: number
  kind: string
  label: string | null
  resetEntity: string | null
  fastbootEntity: string | null
  resetScript: string | null
  /** Empty for a slot that can only reset its board. */
  fastbootScript: string | null
  device: string | null
  confirmedAt: string | null
  canReset: boolean
  canFastboot: boolean
}

export interface HaSettings {
  /** boardd uses the Home Assistant controller; off, its slots are hidden and never pressed (boards stay listed). */
  enabled: boolean
  url: string | null
  hasToken: boolean
  verifiedAt: string | null
  verifyOk: boolean | null
  verifyMessage: string | null
}

/**
 * A remote lab boardd can use. Its boards are listed from the lab once it is enabled; the password, like the HA token,
 * is write-only.
 */
/** One of a lab's access settings as its driver uses it. */
export interface LabField { label: string, placeholder: string | null, required: boolean }
/** The access settings a lab's driver uses, by key; keys it leaves out are hidden. */
export type LabFields = Partial<Record<'url' | 'username' | 'password' | 'jump', LabField>>

export interface LabSettings {
  id: string
  kind: string
  /** The kind it was added as at runtime (it can be removed); null for one boardd's configuration names. */
  addedAs: string | null
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
  /** The lab lists free ports (`labSlots`) and makes boards of them (`bindLab`). */
  canBind: boolean
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

export type ScanStatus = 'running' | 'done' | 'failed' | 'cancelled'
export interface ScanStep { seq: number, at: string, slot: number | null, kind: string, summary: string, data: unknown }
export interface ScanRow {
  slot: number
  board: string | null
  chips: Array<{ die: string, serialPath: string | null, downloadUsbPath: string | null, usbId: string | null, product: string | null, pending: boolean }>
  flags: string[]
}
export interface Scan {
  id: string
  holder: string
  scope: number[]
  status: ScanStatus
  startedAt: string
  finishedAt: string | null
  message: string | null
  steps: ScanStep[]
  result: ScanRow[]
}

export type ProposalKind = 'new-board' | 'replace-board' | 'serial-moved' | 'download-moved' | 'product-changed' | 'slot-empty'
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

export interface HaCandidate { slot: number, resetEntity: string | null, fastbootEntity: string | null, device: string | null }
export interface HaDiscovery { devices: Array<{ id: string, name: string }>, slots: HaCandidate[], unassigned: string[] }

/** A module boardd has loaded. */
export interface ModuleInfo { id: string, title: string }

/** The whole picture. The parts after `modules` come from the modules that keep them, so they are there only with those. */
export interface State {
  boards: Board[]
  labs: LabSettings[]
  firmware: Firmware[]
  proposals: Proposal[]
  modules: ModuleInfo[]
  you: string
  now: string
  /** `local`: this machine's control slots and its latest scan. */
  slots?: Slot[]
  scan?: Scan | null
  /** `home-assistant`. */
  ha?: HaSettings
}

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

/** `gateToken` lets the holder type through serial-mux directly (`smtty --token`); boardd uses it for its own input. */
export interface LockResult { lease: Lease | null, token: string | null, gateToken: string | null, queued: { position: number } | null }
export interface SendResult { output: string, matched: boolean }

/** Events pushed on /api/events. Console bytes use /api/console. */
export type BoardEvent =
  | { type: 'changed', board: string | null }
  | { type: 'scan', scan: Scan }
  | { type: 'lease-stolen', board: string, from: string, by: string, reason: string }
  | { type: 'lease-granted', board: string, holder: string }
  /** A lab's free ports were asked for again, or changed. */
  | { type: 'lab-ports', lab: string, host?: string, added?: string[], removed?: string[] }
  /** A person is asked to act on a board (press RESET, …), or no longer is (message null). */
  | { type: 'attention', board: string, message: string | null, holder: string | null }

/** A lab host's ports that no board uses yet. */
export interface LabSlots { host: string, consoles: Array<{ id: string, label: string }>, usb: Array<{ id: string, label: string }> }

/** A lab's free ports as boardd last heard them: shown at once, refreshed in the background. */
export interface LabPorts { hosts: LabSlots[], at: string | null, refreshing: boolean, error: string | null }
