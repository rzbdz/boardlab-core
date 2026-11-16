/** Typed boardd client over its Unix socket, shared by the CLI and the DSH plugin. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { copyFile, link } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  BoardChannels, BoardDetail, LabPorts, LabSettings, Lease, LockResult, SendResult, State,
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
  /** How the file bytes usually travel, for callers that want to explain it. */
  kind?: 'unix' | 'ssh' | 'web'
  /** The person a remote boardd sees this client as, when the transport says (its login). */
  person?: string
  /** The request to send; `path` starts with /api/. */
  request(method: string, path: string, headers: Record<string, string>): ClientRequest
  /** Put a whole local file at `remote` without an HTTP body (the server gives a ticket path). */
  copyFile?(local: string, remote: string): Promise<void>
  /** Why the last connection could not be made, when the transport knows (an ssh login refused, say). */
  failure?(): string | null
}

export function unixTransport(socketPath: string): Transport {
  return {
    label: socketPath, kind: 'unix',
    request: (method, path, headers) => httpRequest({ socketPath, method, path, headers }),
    // Same machine: a hard link is free; a copy is the fallback across filesystems.
    copyFile: async (local, remote) => { try { await link(local, remote) } catch { await copyFile(local, remote) } },
  }
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
  // The last ssh failure, kept so a request whose socket merely hung up can say what ssh said.
  let lastFailure: string | null = null
  const connect = () => {
    mkdirSync(controlDir, { recursive: true, mode: 0o700 })
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-500) })
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin })
    child.on('error', error => { lastFailure = `ssh ${target} 失败：${error.message}`; stream.destroy(error) })
    child.on('exit', code => {
      if (!code) return
      lastFailure = `ssh ${target} 失败：${stderr.trim() || `退出码 ${code}`}`
      stream.destroy(new Error(lastFailure))
    })
    stream.on('close', () => child.kill())
    return stream as unknown as Socket
  }
  const person = options.person ?? process.env.USER
  return {
    label: url, kind: 'ssh', person,
    failure: () => lastFailure,
    request: (method, path, headers) => httpRequest({
      createConnection: connect, method, path,
      headers: { Host: `127.0.0.1:${port}`, ...(person ? { 'X-Boards-User': person } : {}), Connection: 'close', ...headers },
    }),
    copyFile: (local, remote) => new Promise((resolve, reject) => {
      // The server creates this path, under its own upload directory; refuse anything that could be a shell word.
      if (!/^\/[A-Za-z0-9._/-]+$/.test(remote) || remote.split('/').includes('..')) return reject(new Error(`boardd 给的上传路径不安全：${remote}`))
      mkdirSync(controlDir, { recursive: true, mode: 0o700 })
      // sftp, not scp: a restricted ssh account has sftp enabled but no shell, and OpenSSH 8's scp needs a shell.
      const child = spawn('sftp', ['-q', '-b', '-', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ControlMaster=auto', '-o', `ControlPath=${controlDir}/%C`, '-o', 'ControlPersist=300',
        ...(parsed.port ? ['-P', parsed.port] : []), target], { stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-500) })
      child.on('error', error => reject(new Error(`sftp 到 ${target} 失败：${error.message}`)))
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`sftp 到 ${target} 失败：${stderr.trim() || `退出码 ${code}`}`)))
      // sftp reads one command per line; quote both paths so spaces and quotes survive.
      const quote = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
      child.stdin.end(`put ${quote(local)} ${quote(remote)}\n`)
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
    label: url, kind: 'web', person: login?.user,
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

  /**
   * One call. A read that loses its connection before any answer (an ssh tunnel coming up, a proxy restarting) is
   * tried once more; a write never is, since it may have been done.
   */
  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    try { return await this.once<T>(method, path, body, signal) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const dropped = code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/.test((error as Error).message)
      // The transport knows why (an ssh login refused): say that, not the socket's bare "hang up". ssh may still be
      // exiting when the write fails, so give it a moment to say why.
      let why = dropped ? this.transport.failure?.() : null
      for (let tries = 0; dropped && !why && this.transport.failure && tries < 20 && !signal?.aborted; tries++) {
        await new Promise(resolve => setTimeout(resolve, 25))
        why = this.transport.failure()
      }
      if (why) throw new BoardsApiError(503, why, 'unavailable')
      if (method !== 'GET' || signal?.aborted || !dropped) throw error
      await new Promise(resolve => setTimeout(resolve, 300))
      return this.once<T>(method, path, body, signal)
    }
  }

  private once<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
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

  /**
   * Send a local file for `boot` or `flash`, unless boardd has it already; returns the `sha256:<hex>` they take for it.
   * The file is copied with scp to a path boardd gives and adopted there: no file body goes through boardd's Node
   * process. A web-only connection has no upload path; serve the image by URL or use an ssh client.
   */
  async sendFile(path: string, onSent?: (size: number) => void): Promise<string> {
    if (!this.transport.copyFile) throw new BoardsApiError(400, '网页上传已禁用（RISC-V 上的 Node 处理大请求体会崩溃）；请用 ssh:// 连接的 boardlab CLI，或给一个 http(s) 链接', null)
    const hasher = createHash('sha256')
    for await (const chunk of createReadStream(path)) hasher.update(chunk)
    const sha256 = hasher.digest('hex')
    const have = await this.call<{ present: boolean }>('GET', `/api/files/${sha256}`)
    if (!have.present) {
      await this.sendCopy(path, sha256)
      onSent?.(statSync(path).size)
    }
    return `sha256:${sha256}`
  }

  /** Copy a whole file with scp (or a link on the same machine), then have boardd check and adopt it. */
  private async sendCopy(path: string, sha256: string): Promise<void> {
    const copy = this.transport.copyFile!
    let ticket: { id: string, path: string }
    try {
      ticket = await this.call<{ id: string, path: string }>('POST', '/api/files/ticket', { sha256, name: basename(path) })
    } catch (error) {
      if (error instanceof BoardsApiError && error.status === 404) throw new BoardsApiError(400, 'boardd 太旧，没有 scp 上传接口：升级 boardd，或给一个 http(s) 链接', null)
      throw error
    }
    try {
      await copy(path, ticket.path)
    } catch (error) {
      throw new BoardsApiError(503, `把 ${path} 传到 boardd 所在机器失败：${(error as Error).message}`, 'unavailable')
    }
    try {
      await this.call<{ sha256: string }>('POST', '/api/files/adopt', { id: ticket.id, sha256, name: basename(path) })
    } catch (error) {
      // The bytes arrived but boardd did not take them: say so; never silently resend 100 MB over HTTP.
      throw new BoardsApiError(400, `boardd 没有接收 ${path}：${(error as Error).message}`, null)
    }
  }

  /** A command run by boardd's own CLI for this holder (for commands this client does not know). */
  proxy(args: string[], json: boolean, onOutput: (stream: 'stdout' | 'stderr', text: string) => void) {
    return this.streamCommand('/api/cli', { args, json }, onOutput)
  }

  /** POST a JSON body to a module's streaming endpoint; output events go to `onOutput` until its exit. */
  streamCommand(path: string, payload: unknown, onOutput: (stream: 'stdout' | 'stderr', text: string) => void): Promise<{ code: number, download: string | null }> {
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
        response.on('end', () => { if (!done) reject(new Error('boardd 在命令结束前断开了')) })
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  /** Save a command result file (for example, a remote file-transfer result) to `path`. */
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
  confirm(board: string, note?: string, request?: string | null) { return this.call<{ message: string }>('POST', '/api/confirm', { board, note, request }) }
  channels(board: string) { return this.call<BoardChannels>('GET', `/api/relay?board=${encodeURIComponent(board)}`) }
  setChannel(board: string, channel: string, action: string, ms?: number | null, token?: string | null) { return this.call<{ message: string }>('POST', '/api/relay', { board, channel, action, ms: ms ?? undefined, token }) }
  fastboot(board: string, token?: string | null) { return this.call<{ ok: true }>('POST', '/api/fastboot', { board, token }) }
  send(board: string, input: { die?: string, text: string, newline?: boolean, wait?: string, timeoutMs?: number, token?: string | null }) { return this.call<SendResult>('POST', '/api/send', { board, ...input }) }
  /** Keystrokes for the board's console, sent as they are (needs the lock). */
  input(board: string, input: { die?: string, data: string, token?: string | null, human?: boolean }) { return this.call<{ ok: true }>('POST', '/api/console/input', { board, ...input }) }
  log(board: string, die?: string, lines = 200) { return this.call<{ lines: string[] }>('GET', `/api/log?board=${encodeURIComponent(board)}${die ? `&die=${encodeURIComponent(die)}` : ''}&lines=${lines}`) }
  stage(board: string, firmware: string, die?: string, token?: string | null) { return this.call<{ output: string }>('POST', '/api/stage', { board, firmware, die, token }) }
  boot(board: string, files: string[], die?: string, token?: string | null) { return this.call<{ output: string }>('POST', '/api/boot', { board, files, die, token }) }
  bootSdk(board: string, input: { sdk: string, method?: 'load' | 'download', variant?: string, brk?: string }, token?: string | null) { return this.call<{ output: string }>('POST', '/api/boot/sdk', { board, ...input, token }) }
  /** Where an SDK's recipe can stop early (empty when the backend has no break points). */
  breaks(board: string, sdk: string) { return this.call<{ load: string[], download: string[] }>('GET', `/api/boot/breaks?board=${encodeURIComponent(board)}&sdk=${encodeURIComponent(sdk)}`) }
  /** Agents waiting for a person to let go of a board. */
  yields() { return this.call<Array<{ id: string, board: string, holder: string, purpose: string, owner: string, at: string, until: string }>>('GET', '/api/yields') }
  /** Answer one: `yield` lets the agent have the board now, `deny` keeps it. */
  answerYield(board: string, action: 'yield' | 'deny') { return this.call<{ message: string }>('POST', '/api/yields', { board, action }) }
  /** Let go of the operation running on a board (a boot stuck at a wait, a flash nobody wants). */
  cancelBoard(board: string, token?: string | null) { return this.call<{ message: string }>('POST', '/api/board/cancel', { board, token }) }
  /** Flash a package: a `url` the board's backend downloads, or a file sent first (`sendFile`'s `sha256:<hex>`). */
  flashPackage(board: string, input: { url?: string, sha256?: string, flasher?: string }, token?: string | null) { return this.call<{ output: string }>('POST', '/api/flash/package', { board, ...input, token }) }
  resolveProposals(ids: string[], decision: 'apply' | 'reject', names?: Record<string, string>) { return this.call<{ ok: true }>('POST', '/api/proposals', { ids, decision, names }) }
  /** After re-cabling: have the lab start `host` over (forget its boards, find them again). */
  labKinds() { return this.call<Array<{ kind: string, title: string, about: string }>>('GET', '/api/labs/kinds') }
  addLab(id: string, kind: string) { return this.call<LabSettings>('POST', '/api/labs/add', { id, kind }) }
  removeLab(id: string) { return this.call<{ ok: true }>('POST', '/api/labs/remove', { id }) }
  rebuildLab(id: string, host: string, keepInUse = false) { return this.call<{ message: string, proposals: number, registered?: string[] }>('POST', '/api/labs/rebuild', { id, host, confirmed: true, keepInUse }) }
  discoverLab(id: string, options: { human?: boolean, host?: string, slots?: string[], prefer?: number[] | string } = {}) { return this.call<{ message: string, proposals: number, registered?: string[] }>('POST', '/api/labs/discover', { id, confirmed: true, ...options }) }
  /** Stop a lab's discovery or rebuild (`lab cancel`). */
  cancelDiscovery(id: string) { return this.call<{ message: string }>('POST', '/api/labs/discover/cancel', { id }) }
  /** Read the board in a slot again after a swap; returns its name afterwards. */
  refresh(board: string, options: { name?: string, rename?: boolean } = {}, token?: string | null) { return this.call<{ board: string, message: string }>('POST', '/api/boards/refresh', { board, ...options, token }) }
  /** Rename a board everywhere (backend, chips and serial names, lock, queue, history); returns its name afterwards. */
  renameBoard(board: string, name: string, token?: string | null) { return this.call<{ board: string, message: string }>('POST', '/api/board/rename', { board, name, token }) }
  /** Models people typed in themselves, most recent first. */
  models() { return this.call<{ models: string[] }>('GET', '/api/models') }
  /** Set or clear a board's model; a set one is remembered for the dropdown. */
  setModel(board: string, product: string | null) { return this.call<{ ok: true }>('POST', '/api/board', { name: board, product }) }
  labSlots(id: string, fresh = true) { return this.call<LabPorts>('GET', `/api/labs/slots?id=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`) }
  bindLab(id: string, input: { host?: string, console?: string, usb?: string, name?: string }) { return this.call<{ board: string, host: string, console: string, usb: string }>('POST', '/api/labs/bind', { id, ...input }) }
  removeBoard(name: string) { return this.call<{ ok: true }>('POST', '/api/boards/remove', { name }) }
  exportToml() { return this.call<string>('GET', '/api/export.toml') }
}
