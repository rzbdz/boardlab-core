/** Typed boardd client over its Unix socket, shared by the CLI and the DSH plugin. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  BoardChannels, BoardDetail, HaDiscovery, HaSettings, LabPorts, Lease, LockResult, Scan, SendResult, Slot, State,
} from './types.ts'

export const DEFAULT_PORT = 38127

/** A directory under `base` named `name`, or the one an older version made under `legacy` while there is no new one. */
function named(base: string, name: string, legacy: string): string {
  const path = join(base, name)
  return !existsSync(path) && existsSync(join(base, legacy)) ? join(base, legacy) : path
}

/** boardd's state: `$BOARDS_STATE_DIR`, else `~/.local/state/boardlab` (or the `troy-boards` an older boardlab made). */
export function defaultStateDir(): string {
  return process.env.BOARDS_STATE_DIR ?? named(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'boardlab', 'troy-boards')
}

export const socketPathFor = (stateDir: string) => join(stateDir, 'boardd.sock')

export class BoardsApiError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null) { super(message) }
}

/**
 * Where boardd is: its Unix socket on this machine, or a boardd elsewhere reached through an ssh tunnel to its loopback
 * port (`ssh://[user@]host[:port]`, for networks that only let ssh through) or through a proxy serving its page
 * (`http(s)://host/prefix`, with basic auth when the proxy asks for a login).
 */
export interface Transport {
  label: string
  /** The person a remote boardd sees this client as, when the transport says (its login). */
  person?: string
  /** The request to send; `path` starts with /api/. */
  request(method: string, path: string, headers: Record<string, string>): ClientRequest
}

export function unixTransport(socketPath: string): Transport {
  return { label: socketPath, request: (method, path, headers) => httpRequest({ socketPath, method, path, headers }) }
}

/** `ssh://[user@]host[:port]`: each connection is `ssh -W 127.0.0.1:<boardd port>`, sharing one ssh login for a while. */
export function sshTransport(url: string, options: { boarddPort?: number, person?: string, controlDir?: string } = {}): Transport {
  const parsed = new URL(url)
  const target = `${parsed.username ? `${decodeURIComponent(parsed.username)}@` : ''}${parsed.hostname}`
  const port = options.boarddPort ?? Number(parsed.searchParams.get('boardd') ?? DEFAULT_PORT)
  const controlDir = options.controlDir ?? join(process.env.XDG_RUNTIME_DIR ?? join(homedir(), '.cache'), 'boards-ssh')
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ControlMaster=auto', '-o', `ControlPath=${controlDir}/%C`, '-o', 'ControlPersist=300',
    ...(parsed.port ? ['-p', parsed.port] : []), '-W', `127.0.0.1:${port}`, target]
  const connect = () => {
    mkdirSync(controlDir, { recursive: true, mode: 0o700 })
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-500) })
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin })
    child.on('error', error => stream.destroy(error))
    child.on('exit', code => { if (code) stream.destroy(new Error(`ssh ${target} 失败：${stderr.trim() || `退出码 ${code}`}`)) })
    stream.on('close', () => child.kill())
    return stream as unknown as Socket
  }
  const person = options.person ?? process.env.USER
  return {
    label: url, person,
    request: (method, path, headers) => httpRequest({
      createConnection: connect, method, path,
      headers: { Host: `127.0.0.1:${port}`, ...(person ? { 'X-Boards-User': person } : {}), Connection: 'close', ...headers },
    }),
  }
}

/** `http(s)://host[:port]/prefix`: boardd behind the proxy that serves its page, logging in as `user` when given. */
export function webTransport(url: string, login?: { user: string, password: string }): Transport {
  const base = new URL(url)
  const prefix = base.pathname.replace(/\/+$/, '')
  const send = base.protocol === 'https:' ? httpsRequest : httpRequest
  const auth = login ? { Authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString('base64')}` } : {}
  return {
    label: url, person: login?.user,
    request: (method, path, headers) => send({
      protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, method, path: prefix + path,
      // The proxy accepts writes from its own page's origin.
      headers: { Origin: base.origin, ...auth, ...headers },
    }),
  }
}

/** What `boardlab remote set` saves: which boardd this user's CLI talks to. */
export interface RemoteConfig { url: string, user?: string, password?: string }

export function remoteConfigPath(): string {
  return join(named(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'boardlab', 'boards'), 'remote.json')
}

/** The boardd to use: $BOARDS_REMOTE, else the saved remote, else the local socket. */
export function defaultTransport(socketPath: string): Transport {
  let config: RemoteConfig | null = null
  if (process.env.BOARDS_REMOTE) config = { url: process.env.BOARDS_REMOTE, user: process.env.BOARDS_USER, password: process.env.BOARDS_PASSWORD }
  else if (existsSync(remoteConfigPath())) {
    try { config = JSON.parse(readFileSync(remoteConfigPath(), 'utf8')) } catch {}
  }
  if (!config?.url) return unixTransport(socketPath)
  return transportFor(config)
}

export function transportFor(config: RemoteConfig): Transport {
  if (config.url.startsWith('ssh://')) return sshTransport(config.url, { person: config.user })
  if (/^https?:\/\//.test(config.url)) return webTransport(config.url, config.user && config.password ? { user: config.user, password: config.password } : undefined)
  throw new Error(`远程 boardd 地址要以 ssh://、http:// 或 https:// 开头：${config.url}`)
}

export class BoardsClient {
  readonly transport: Transport
  constructor(target: string | Transport = socketPathFor(defaultStateDir()), readonly holder?: string) {
    this.transport = typeof target === 'string' ? unixTransport(target) : target
  }

  /** A raw request with the holder set, for streams the typed calls do not cover. */
  open(method: 'GET' | 'POST' | 'PUT', path: string, headers: Record<string, string> = {}): ClientRequest {
    return this.transport.request(method, path, { ...(this.holder ? { 'x-boards-holder': this.holder } : {}), ...headers })
  }

  call<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      // A length rather than chunks: proxies in front of boardd (a site's hub) may read only sized bodies.
      const req = this.open(method, path, payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {})
      signal?.addEventListener('abort', () => req.destroy(new Error('已取消')), { once: true })
      req.on('response', response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if ((response.statusCode ?? 500) >= 400) {
            let parsed: { error?: string, code?: string } = {}
            try { parsed = JSON.parse(text) } catch {}
            if (response.statusCode === 401) return reject(new BoardsApiError(401, `${this.transport.label} 要登录：boardlab remote set <地址> --user <名字> --password-stdin`, 'unauthorized'))
            return reject(new BoardsApiError(response.statusCode ?? 500, parsed.error ?? text, parsed.code ?? null))
          }
          resolve((response.headers['content-type'] ?? '').startsWith('application/json') ? JSON.parse(text) : text as T)
        })
      })
      req.on('error', error => reject((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ECONNREFUSED'
        ? new BoardsApiError(503, `boardd 没有运行（${this.transport.label}）`, 'unavailable') : error))
      if (payload) req.write(payload)
      req.end()
    })
  }

  /** Send a local file for `boot`, unless boardd has it already; returns the `sha256:<hex>` boot takes for it. */
  async sendFile(path: string, onSent?: (size: number) => void): Promise<string> {
    const hasher = createHash('sha256')
    for await (const chunk of createReadStream(path)) hasher.update(chunk)
    const sha256 = hasher.digest('hex')
    const have = await this.call<{ present: boolean }>('GET', `/api/files/${sha256}`)
    if (!have.present) {
      const size = statSync(path).size
      await new Promise<void>((resolve, reject) => {
        const req = this.open('PUT', `/api/files/${sha256}?name=${encodeURIComponent(basename(path))}`, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) })
        req.on('response', response => {
          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(chunk))
          response.on('end', () => {
            if ((response.statusCode ?? 500) < 400) return resolve()
            let message = Buffer.concat(chunks).toString('utf8')
            try { message = JSON.parse(message).error ?? message } catch {}
            reject(new BoardsApiError(response.statusCode ?? 500, `传 ${path} 失败：${message}`, null))
          })
        })
        req.on('error', reject)
        createReadStream(path).pipe(req)
      })
      onSent?.(size)
    }
    return `sha256:${sha256}`
  }

  /** A boardlab command run by boardd's own CLI for this holder (for commands this client does not know). */
  proxy(args: string[], json: boolean, onOutput: (stream: 'stdout' | 'stderr', text: string) => void) {
    return this.stream('/api/cli', { args, json }, onOutput)
  }

  /** `bsp sdk <args>` run by boardd for this holder; output arrives as it is written. */
  sdk(args: string[], json: boolean, onOutput: (stream: 'stdout' | 'stderr', text: string) => void, group: 'sdk' | 'catalog' | 'raw' = 'sdk'): Promise<{ code: number, download: string | null }> {
    return this.stream('/api/sdk', { args, json, group }, onOutput)
  }

  /** POST a JSON body to a streaming endpoint; output events go to `onOutput` until its exit. */
  private stream(path: string, payload: unknown, onOutput: (stream: 'stdout' | 'stderr', text: string) => void): Promise<{ code: number, download: string | null }> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload)
      const req = this.open('POST', path, { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': String(Buffer.byteLength(body)) })
      req.on('response', response => {
        if ((response.statusCode ?? 500) >= 400) {
          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(chunk))
          response.on('end', () => { let message = Buffer.concat(chunks).toString('utf8'); try { message = JSON.parse(message).error ?? message } catch {} ; reject(new BoardsApiError(response.statusCode ?? 500, message, null)) })
          return
        }
        let buffer = '', done = false
        response.setEncoding('utf8')
        response.on('data', chunk => {
          buffer += chunk
          let index
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index); buffer = buffer.slice(index + 2)
            const event = block.match(/^event: (.*)$/m)?.[1]
            const data = block.match(/^data: (.*)$/m)?.[1]
            if (!data) continue
            const value = JSON.parse(data)
            if (event === 'out') onOutput(value.stream, value.text)
            else if (event === 'exit') { done = true; resolve(value) }
            else if (event === 'error') { done = true; reject(new BoardsApiError(400, value.message, null)) }
          }
        })
        response.on('end', () => { if (!done) reject(new Error('boardd 在 sdk 命令结束前断开了')) })
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  /** Save a file boardd holds (a `boardlab sdk get -o` result) to `path`. */
  fetchFile(sha256: string, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = this.open('GET', `/api/files/${sha256}?download=1`)
      req.on('response', response => {
        if ((response.statusCode ?? 500) >= 400) { response.resume(); return reject(new BoardsApiError(response.statusCode ?? 500, `取不回文件 ${sha256.slice(0, 12)}…`, null)) }
        const out = createWriteStream(path)
        response.pipe(out)
        out.on('finish', () => resolve())
        out.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
  }

  state() { return this.call<State>('GET', '/api/state') }
  board(name: string) { return this.call<BoardDetail>('GET', `/api/board?name=${encodeURIComponent(name)}`) }
  lock(board: string, purpose: string, queue: 'none' | 'join' | 'wait' = 'none', signal?: AbortSignal) { return this.call<LockResult>('POST', '/api/lock', { board, purpose, queue }, signal) }
  unqueue(board: string) { return this.call<{ ok: true }>('POST', '/api/unqueue', { board }) }
  unlock(board: string, token?: string | null) { return this.call<{ ok: true }>('POST', '/api/unlock', { board, token }) }
  steal(board: string, reason: string) { return this.call<LockResult>('POST', '/api/steal', { board, reason }) }
  reset(board: string, token?: string | null) { return this.call<{ ok: true }>('POST', '/api/reset', { board, token }) }
  confirm(board: string, note?: string) { return this.call<{ message: string }>('POST', '/api/confirm', { board, note }) }
  channels(board: string) { return this.call<BoardChannels>('GET', `/api/relay?board=${encodeURIComponent(board)}`) }
  setChannel(board: string, channel: string, action: string, ms?: number | null, token?: string | null) { return this.call<{ message: string }>('POST', '/api/relay', { board, channel, action, ms: ms ?? undefined, token }) }
  fastboot(board: string, token?: string | null) { return this.call<{ ok: true }>('POST', '/api/fastboot', { board, token }) }
  send(board: string, input: { die?: string, text: string, newline?: boolean, wait?: string, timeoutMs?: number, token?: string | null }) { return this.call<SendResult>('POST', '/api/send', { board, ...input }) }
  /** Keystrokes for the board's console, sent as they are (needs the lock). */
  input(board: string, input: { die?: string, data: string, token?: string | null, human?: boolean }) { return this.call<{ ok: true }>('POST', '/api/console/input', { board, ...input }) }
  log(board: string, die?: string, lines = 200) { return this.call<{ lines: string[] }>('GET', `/api/log?board=${encodeURIComponent(board)}${die ? `&die=${encodeURIComponent(die)}` : ''}&lines=${lines}`) }
  stage(board: string, firmware: string, die?: string, token?: string | null) { return this.call<{ output: string }>('POST', '/api/stage', { board, firmware, die, token }) }
  boot(board: string, files: string[], die?: string, token?: string | null) { return this.call<{ output: string }>('POST', '/api/boot', { board, files, die, token }) }
  bootSdk(board: string, input: { sdk: string, method?: 'load' | 'download', variant?: string }, token?: string | null) { return this.call<{ output: string }>('POST', '/api/boot/sdk', { board, ...input, token }) }
  scan(input: { slots?: number[], boards?: string[], confirmed: boolean }) { return this.call<Scan>('POST', '/api/scan', input) }
  scanStatus(id: string) { return this.call<Scan>('GET', `/api/scan?id=${encodeURIComponent(id)}`) }
  cancelScan(id: string) { return this.call<{ ok: true }>('POST', '/api/scan/cancel', { id }) }
  resolveProposals(ids: string[], decision: 'apply' | 'reject', names?: Record<string, string>) { return this.call<{ ok: true }>('POST', '/api/proposals', { ids, decision, names }) }
  saveScriptSlot(input: { slot: number, label?: string | null, resetScript: string, fastbootScript?: string | null }) { return this.call<Slot>('POST', '/api/slots/script', input) }
  removeScriptSlot(slot: number) { return this.call<{ ok: true }>('POST', '/api/slots/script/remove', { slot }) }
  configureHa(url: string, token?: string) { return this.call<HaSettings>('POST', '/api/ha', { url, token }) }
  setHaEnabled(enabled: boolean) { return this.call<HaSettings>('POST', '/api/ha/enabled', { enabled }) }
  testHa() { return this.call<HaSettings>('POST', '/api/ha/test') }
  discoverLab(id: string, options: { human?: boolean, host?: string, slots?: string[] } = {}) { return this.call<{ message: string, proposals: number, registered?: string[] }>('POST', '/api/labs/discover', { id, confirmed: true, ...options }) }
  /** Read the board in a slot again after a swap; returns its name afterwards. */
  refresh(board: string, options: { name?: string, rename?: boolean } = {}, token?: string | null) { return this.call<{ board: string, message: string }>('POST', '/api/boards/refresh', { board, ...options, token }) }
  labSlots(id: string, fresh = true) { return this.call<LabPorts>('GET', `/api/labs/slots?id=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`) }
  bindLab(id: string, input: { host: string, console: string, usb: string, name?: string }) { return this.call<{ board: string }>('POST', '/api/labs/bind', { id, ...input }) }
  removeBoard(name: string) { return this.call<{ ok: true }>('POST', '/api/boards/remove', { name }) }
  exportToml() { return this.call<string>('GET', '/api/export.toml') }
}
