/**
 * The contract between boardlab and a flasher host backend. boardlab is the registry, gateway and user interface of a
 * set of flasher hosts; a backend is one kind of them: this machine, a rack behind a management controller, a fleet of board hosts. What every backend
 * offers is the same three things, a relay to reset boards, a USB download path and a serial port; the rest is optional
 * and the core offers it only for backends that have it.
 */
import type { Channel as WireChannel, LabFields } from '../shared/types.ts'
import type { ConsoleSession } from './console.ts'

/** What reaching a backend takes, as entered in its settings. */
export interface LabConfig { url: string, username: string, password: string, jump: string }

/** One board as its backend lists it, or an empty slot: a place for a board that so far has only a console. */
export interface LabDevice {
  /** What boardlab calls it, after the backend's prefix: `<backend>-<name>`. */
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
  ip: string | null
  /** Who holds the board in the backend itself, when that is not boardd (someone using it directly). */
  heldBy?: string | null
  /** What a person is asked to do on the board right now (press RESET, …), for boards reset by hand. */
  attention?: string | null
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
  /** The chip's serial port as the backend names it, for backends whose ports boardlab names (serial-mux aliases). */
  port: string | null
  /** The token of the input gate the board's lock holds, for backends whose consoles have gates (see `gated`). */
  gate: string | null
}

/** A file on this machine to load into a board. */
export interface BootFile { path: string, sha256: string }
/** How long a RAM boot waits for the download port between files. */
export interface PortTiming { firstMs: number, laterMs: number, waitMs: number }

/** What a backend tells boardd as it happens. */
export type LabNews =
  | { kind: 'ports', host: string, added: string[], removed: string[] }
  | { kind: 'hosts', host: string }

/**
 * How a backend looks for boards: by itself (pulsing reset lines), or with a person resetting each unregistered board
 * into download mode on one `host` while the backend pairs consoles with download ports.
 */
export interface LabDiscovery {
  human?: boolean
  host?: string | null
  /** Only these slots (`<host>/s4`). */
  slots?: string[]
}
/** A board a scan found: what it suggests calling it, a line for people, and what registering it takes. */
export interface LabFinding { host: string | null, name: string, summary: string, warnings: string[], detail: unknown }
/** One host's ports no board uses: what a new cable shows up as before it is a board. */
export interface LabSlots { host: string, consoles: Array<{ id: string, label: string }>, usb: Array<{ id: string, label: string }> }
/** A board's lease in the backend, held for whoever holds its lock in boardd. */
export interface LabHolder { holder: string, purpose: string, token: string | null }

/** `notice` gets what a person is asked to do while a board reset by hand waits for them, and null once it is done. */
export type Notice = (message: string | null) => void

/** The relay: restarting boards. */
export interface RelayCapability {
  /**
   * Check that the board can do it and say what will be pressed, for the action log; throws when it cannot. Without it
   * the log names the backend and its device.
   */
  describe?(target: BoardTarget, action: 'reset' | 'download'): string
  reset(config: LabConfig, target: BoardTarget, notice?: Notice): Promise<string | void>
  /**
   * Restart the board into its boot ROM's download mode. A backend that only learns which download port is the board's
   * by watching it appear returns that port.
   */
  enterDownload(config: LabConfig, target: BoardTarget, notice?: Notice): Promise<string | void>
  /** Tell the backend that the person did what a waiting reset asked of them. */
  confirm?(config: LabConfig, target: BoardTarget, note: string): Promise<string>
}

/** What can be done to a channel: relays switch, buttons are pressed; `pulse` and `click` do it for `ms` and undo it. */
export type ChannelAction = 'on' | 'off' | 'toggle' | 'pulse' | 'press' | 'release' | 'click'
export const CHANNEL_ACTIONS: ChannelAction[] = ['on', 'off', 'toggle', 'pulse', 'press', 'release', 'click']

/** One relay, button or line wired to a board, as its relay controller names it (`<board>/reset`, `<board>/power`). */
export interface Channel extends WireChannel { actions: ChannelAction[] }

/**
 * For a backend whose relay controller lets each of a board's lines be worked by hand (bsp's gpio_relay): beyond reset
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
  /** Its consoles have input gates that follow the lock, so a lock comes with a gate token (`smtty --token`). */
  gated?: boolean
}

/** The USB download path. Loading runs from RAM and never flashes. */
export interface DownloadCapability {
  /** Load a file into RAM through the download port and let it run. */
  stage(config: LabConfig, target: BoardTarget, file: BootFile, timeoutMs?: number): Promise<string>
  /** Whether the download port is enumerated. */
  present(config: LabConfig, target: BoardTarget): Promise<boolean>
  /**
   * For a backend that can run a whole RAM boot itself: load the files in order, waiting for the download port between
   * them as `timing` says, in one call. Without it boardd stages file by file.
   */
  boot?(config: LabConfig, target: BoardTarget, files: BootFile[], timing: PortTiming): Promise<string>
}

/** The boards of a backend that lists them itself; the rest register boards through boardd. */
export interface InventoryCapability {
  verify(config: LabConfig): Promise<string>
  devices(config: LabConfig): Promise<LabDevice[]>
  /**
   * Read the board in a slot again after someone swapped it: identify it and update the backend's record of it, under
   * its lease. `name` renames it, `rename` names it after what was read. Returns its name afterwards.
   */
  refresh?(config: LabConfig, target: BoardTarget, options: { name?: string | null, rename?: boolean }, progress: (line: string) => void): Promise<{ device: string, message: string }>
  /** For a backend that keeps a board registry: forget a board there. boardd only asks while nobody holds it. */
  remove?(config: LabConfig, device: string): Promise<void>
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
   * Look for new boards. A backend that can registers each the moment it is found and says so through `registered`;
   * the rest are reported as findings for a person to review as proposals, and applying one calls `register`. It may
   * reset boards, so boardd only runs it on a person's confirmation while none of the backend's boards is held.
   */
  discover(config: LabConfig, options: LabDiscovery, progress: (line: string) => void, registered?: (device: string) => void): Promise<{ message: string, found: LabFinding[] }>
  /** Register a board a scan found, under `name` (the backend's own name for it). */
  register(config: LabConfig, finding: LabFinding, name: string): Promise<void>
  /**
   * Start one host over after it was re-cabled: drop the backend's own record of what is wired to `host` and find
   * its boards again, registering each as found (`registered`), as `discover` does. Boards the backend was told about
   * by hand stay. It resets boards, so boardd runs it only on a person's confirmation while none of that host's boards
   * is held.
   */
  rebuild?(config: LabConfig, host: string, progress: (line: string) => void, registered?: (device: string) => void): Promise<{ message: string, found: LabFinding[] }>
}

/** For a backend that can tell: its free ports, and making boards of them. */
export interface PortsCapability {
  /** Each host's serial consoles and download ports no board uses yet. */
  list(config: LabConfig): Promise<LabSlots[]>
  /** Make a board of a free console and download port, reset by a person (for temporary debugging, say). */
  bind(config: LabConfig, host: string, ports: { console: string, usb: string }, name: string): Promise<void>
}

/** For a backend that knows named builds (SDKs): booting or flashing a board with one, fetching the build itself. */
export interface BuildsCapability {
  boot(config: LabConfig, target: BoardTarget, build: { sdk: string, method: 'load' | 'download', variant: string | null }, progress: (line: string) => void): Promise<string>
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
  news?: NewsCapability
}

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
