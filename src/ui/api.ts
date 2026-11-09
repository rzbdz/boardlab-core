/**
 * Browser access to boardd's API: the core's calls here, a module's in its UI part. The page acts as the local user, so it never handles lease tokens. Paths are
 * relative, so the page also works behind a reverse proxy under a path such as `/boardlab/`.
 */
import type { Action, BoardChannels, BoardDetail, HaSettings, LabPorts, LabSettings, Lease, LockResult, Scan, SendResult, Slot, State } from '../shared/types.ts'

/** The state as the page uses it: the parts modules keep are filled in when their module is not loaded. */
/** Actions and locks, and whatever modules add (`scans`). */
export type History = { actions: Action[], leases: Lease[] } & Record<string, unknown>

export type PageState = Omit<State, 'slots' | 'scan' | 'ha'> & { slots: Slot[], scan: Scan | null, ha: HaSettings | null }
const page = (state: State): PageState => ({ ...state, slots: state.slots ?? [], scan: state.scan ?? null, ha: state.ha ?? null })

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }

const USER_KEY = 'boards.user'
/** The name this browser acts under; empty means boardd's local user. */
export const identity = {
  get: () => localStorage.getItem(USER_KEY) ?? '',
  set: (name: string) => name ? localStorage.setItem(USER_KEY, name) : localStorage.removeItem(USER_KEY),
}

export async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const user = identity.get()
  const response = await fetch(path, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(user ? { 'X-Boards-User': user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    let message = text
    try { message = JSON.parse(text).error ?? text } catch {}
    throw new ApiError(response.status, message)
  }
  return (response.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text as T
}

export const api = {
  state: () => call<State>('GET', 'api/state').then(page),
  board: (name: string) => call<BoardDetail>('GET', `api/board?name=${encodeURIComponent(name)}`),
  history: () => call<History>('GET', 'api/history'),
  lock: (board: string, purpose: string) => call<LockResult>('POST', 'api/lock', { board, purpose }),
  queue: (board: string, purpose: string) => call<LockResult>('POST', 'api/lock', { board, purpose, queue: 'join' }),
  unqueue: (board: string) => call('POST', 'api/unqueue', { board }),
  unlock: (board: string) => call('POST', 'api/unlock', { board }),
  steal: (board: string, reason: string) => call<LockResult>('POST', 'api/steal', { board, reason }),
  reset: (board: string) => call('POST', 'api/reset', { board }),
  channels: (board: string) => call<BoardChannels>('GET', `api/relay?board=${encodeURIComponent(board)}`),
  setChannel: (board: string, channel: string, action: string, ms: number | null) => call<{ message: string }>('POST', 'api/relay', { board, channel, action, ms: ms ?? undefined }),
  confirm: (board: string) => call<{ message: string }>('POST', 'api/confirm', { board }),
  bootSdk: (board: string, sdk: string, method: 'load' | 'download') => call<{ output: string }>('POST', 'api/boot/sdk', { board, sdk, method }),
  fastboot: (board: string) => call('POST', 'api/fastboot', { board }),
  /** Keystrokes for the online console, sent as they are. */
  // People on the page type without the lock (agents use the CLI and need it).
  input: (board: string, die: string | undefined, data: string) => call('POST', 'api/console/input', { board, die, data, human: true }),
  // Fire and forget: the console stream already shows the output, so the request does not wait for any.
  send: (board: string, die: string | undefined, text: string) => call<SendResult>('POST', 'api/send', { board, die, text, newline: true, timeoutMs: 0 }),
  proposals: (ids: string[], decision: 'apply' | 'reject', names?: Record<string, string>) => call('POST', 'api/proposals', { ids, decision, names }),
  // The password goes only when typed; leaving it empty keeps the stored one.
  configureLab: (input: { id: string, enabled: boolean, url: string, username: string, password?: string, jump: string, devices: string }) => call<LabSettings>('POST', 'api/labs', { ...input, password: input.password || undefined }),
  testLab: (id: string) => call<LabSettings>('POST', 'api/labs/test', { id }),
  refresh: (board: string, options: { name?: string, rename?: boolean }) => call<{ board: string, message: string }>('POST', 'api/boards/refresh', { board, ...options }),
  rebuildLab: (id: string, host: string) => call<{ message: string }>('POST', 'api/labs/rebuild', { id, host, confirmed: true }),
  discoverLab: (id: string, options: { human?: boolean, host?: string, slots?: string[] } = {}) => call<{ message: string }>('POST', 'api/labs/discover', { id, confirmed: true, ...options }),
  labPorts: (id: string, fresh = false) => call<LabPorts>('GET', `api/labs/slots?id=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`),
  bindLab: (id: string, input: { host: string, console: string, usb: string, name?: string }) => call<{ board: string }>('POST', 'api/labs/bind', { id, ...input }),
  removeBoard: (name: string) => call('POST', 'api/boards/remove', { name }),
}
