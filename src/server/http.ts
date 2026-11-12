/**
 * The HTTP gateway: every endpoint of the lab's API, on 127.0.0.1 (and opted-in hosts) for the page and remote CLIs, and
 * on a Unix socket for local CLIs. JSON in and out, event streams as SSE, files as bytes. It also decides who is calling,
 * refuses foreign hosts and cross-site writes, serves a UI when it is given one, and runs commands older CLIs do not know.
 */
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, createReadStream, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import { extname, join } from 'node:path'
import { Api, EventStream, FileReply, RawReply, TextReply, type Caller, type Emit, type Endpoint } from '../core/api.ts'
import { BoardError } from '../core/errors.ts'
import type { BoardLab } from '../core/lab.ts'
import { HOLDER } from '../core/text.ts'
import { API_VERSION } from '../shared/types.ts'

const STATUS: Record<BoardError['code'], number> = { 'not-found': 404, invalid: 400, locked: 423, forbidden: 403, conflict: 409, hardware: 502 }
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }
const HOLDER_HEADER = 'x-boards-holder'
const USER_HEADER = 'x-boards-user'
const AGENT = HOLDER

/**
 * `origins` are the addresses the page is also served at through a reverse proxy (`https://example.org`), whose
 * writes are accepted; the proxy forwards with `Host: 127.0.0.1:<port>`. `uiDir` is the UI to serve (null: none).
 * `docsDir` holds the help pages (`<name>.md`) the page and the CLI show (null: none).
 */
export interface ServeOptions {
  port: number, hosts?: string[], origins?: string[], socketPath: string, uiDir: string | null, cli?: string, stateDir?: string, docsDir?: string | null,
  /** This boardd's release, and the HTTP API version it serves (see GET /api/version). */
  version?: string, revision?: string,
  /**
   * Whether this process makes the Unix socket (default): one boardd. Under a supervisor it is false — the socket is
   * shared by every worker, so a worker neither removes nor re-permissions it.
   */
  ownSocket?: boolean,
}
/**
 * What the gateway's own endpoints need from how boardd runs: its own CLI (to run commands for older clients), state
 * directory, and help pages.
 */
type GatewayOptions = { cli?: string, stateDir?: string, docsDir?: string | null, version?: string, revision?: string }

export function createApi(lab: BoardLab, options: GatewayOptions = {}): (request: IncomingMessage, response: ServerResponse, caller: Caller) => Promise<void> {
  // The gateway's own endpoints, served beside the lab's; its index lists both.
  const own = new Api()
  own.add('gateway', [cliEndpoint(options), ...docsEndpoints(options.docsDir ?? null), {
    method: 'GET', path: '/api/version', about: 'boardd 的版本和它提供的 API 版本', handle: () => ({ version: options.version ?? 'dev', revision: options.revision ?? 'dev', api: API_VERSION }),
  }, {
    method: 'GET', path: '/api', about: '列出所有接口和模块', handle: () => {
      const described = [...lab.api.list().filter(item => item.path !== '/api'), ...own.list()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
      return { endpoints: described.map(item => `${item.method} ${item.path}`), described, modules: lab.modules() }
    },
  }])
  return async (request, response, caller) => {
    const url = new URL(request.url ?? '/', 'http://boardd')
    response.setHeader('Cache-Control', 'no-store')
    const found = own.match(request.method ?? 'GET', url.pathname) ?? lab.api.match(request.method ?? 'GET', url.pathname)
    if (!found) return void send(response, 404, { error: '没有这个接口' })
    const raw = (found.endpoint.body ?? (request.method === 'PUT' ? 'raw' : 'json')) === 'raw'
    const abort = new AbortController()
    response.on('close', () => { if (!response.writableFinished) abort.abort() })
    try {
      const body = !raw && request.method !== 'GET' ? await readJson(request) : {}
      const reply = await found.endpoint.handle({ body, query: url.searchParams, params: found.params, headers: request.headers, caller, signal: abort.signal, upload: raw ? request : null })
      await answer(response, reply, abort)
    } catch (error) {
      if (raw) request.resume()
      if (error instanceof BoardError) send(response, STATUS[error.code], { error: error.message, code: error.code })
      else send(response, 500, { error: (error as Error).message })
    }
  }
}

async function answer(response: ServerResponse, reply: unknown, abort: AbortController) {
  if (reply instanceof EventStream) return stream(response, reply, abort)
  if (reply instanceof TextReply) {
    response.writeHead(200, { 'Content-Type': reply.type, ...(reply.filename ? { 'Content-Disposition': `attachment; filename="${reply.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"` } : {}) })
    return void response.end(reply.text)
  }
  if (reply instanceof RawReply) {
    response.writeHead(reply.status, reply.headers)
    if (!reply.body) return void response.end()
    // Each chunk as it comes (an event stream stays live), until the caller goes.
    try { for await (const chunk of reply.body) { if (abort.signal.aborted) break; response.write(chunk) } }
    finally { if (!response.writableEnded) response.end() }
    return
  }
  if (reply instanceof FileReply) {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(statSync(reply.path).size) })
    return void createReadStream(reply.path).pipe(response)
  }
  send(response, 200, reply ?? { ok: true })
}

/** An event stream as SSE. A caller that vanished (a proxy keeping the connection, a sleeping laptop) is noticed when it cannot be written to. */
async function stream(response: ServerResponse, reply: EventStream, abort: AbortController) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
  const ping = setInterval(() => {
    if (response.destroyed || !response.writable) return abort.abort()
    response.write(': ping\n\n')
  }, 15_000)
  const stop = () => clearInterval(ping)
  abort.signal.addEventListener('abort', stop, { once: true })
  response.on('close', stop)
  const emit: Emit = (event, data) => { if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  const end = () => { stop(); if (!response.writableEnded) response.end() }
  try { await reply.start(emit, end, abort.signal) }
  catch (error) { emit('error', { message: (error as Error).message }); end() }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) { response.end(); return }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<any> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw new BoardError('invalid', '请求太大')
    chunks.push(chunk)
  }
  if (!size) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new BoardError('invalid', '请求不是合法 JSON') }
}

/**
 * Commands an older CLI does not know: boardd runs its own CLI with them for the caller, against itself, and streams the
 * output back, so new commands reach every client without updating it. Commands that only make sense on the caller's
 * machine (an interactive console, installing, choosing a boardd, running one) are refused.
 */
export const CLI_LOCAL_ONLY = new Set(['serve', 'install', 'remote', 'console'])
const DOC = /^[a-z0-9][a-z0-9-]{0,39}$/
/** A help page's title: its first `# ` heading, or its name. */
const docTitle = (text: string, name: string) => /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? name

/** `GET /api/docs`, `GET /api/docs/<name>`: the help pages shipped with the distribution, as Markdown. */
function docsEndpoints(dir: string | null): Endpoint[] {
  const read = (name: string) => {
    const file = dir && DOC.test(name) ? join(dir, `${name}.md`) : null
    if (!file || !existsSync(file)) throw new BoardError('not-found', `没有帮助页 ${name}`)
    return readFileSync(file, 'utf8')
  }
  return [{
    method: 'GET', path: '/api/docs', about: '帮助页的列表（name、title）',
    handle: () => ({
      docs: (dir && existsSync(dir) ? readdirSync(dir) : []).filter(file => file.endsWith('.md') && DOC.test(file.slice(0, -3))).sort()
        .map(file => { const name = file.slice(0, -3); return { name, title: docTitle(read(name), name) } }),
    }),
  }, {
    method: 'GET', path: '/api/docs/:name', about: '一页帮助（Markdown）：name、title、text',
    handle: ({ params }) => { const name = String(params.name ?? ''), text = read(name); return { name, title: docTitle(text, name), text } },
  }]
}

function cliEndpoint(options: GatewayOptions): Endpoint {
  return {
    method: 'POST', path: '/api/cli', about: '用 boardd 自己的 boardlab 命令行替调用者跑命令（旧客户端不认识的命令）',
    handle: ({ body, caller }) => {
      const args: unknown = body.args
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new BoardError('invalid', 'args 要是字符串数组')
      if (!options.cli || !options.stateDir) throw new BoardError('invalid', '这个 boardd 不代跑命令')
      const command = (args as string[]).find(arg => !arg.startsWith('-'))
      if (command && CLI_LOCAL_ONLY.has(command)) throw new BoardError('invalid', `boardlab ${command} 要在你自己的机器上跑，请更新本机的 boardlab`)
      if ((args as string[]).some(arg => arg === '--as' || arg.startsWith('--as=') || arg === '--state-dir' || arg.startsWith('--state-dir='))) {
        throw new BoardError('invalid', '代跑的命令以调用者的身份执行，不能带 --as 或 --state-dir')
      }
      return new EventStream((emit, end, signal) => {
        // The same Node flags as boardd itself (on some CPUs it needs --no-sparkplug to run at all).
        const child = spawn(process.execPath, [...process.execArgv, options.cli!, ...(args as string[]), ...(body.json === true ? ['--json'] : [])], {
          env: { ...process.env, BOARDS_HOLDER: caller.holder, BOARDS_STATE_DIR: options.stateDir, BOARDS_REMOTE: '', BOARDS_PROXIED: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        child.stdout.setEncoding('utf8').on('data', text => emit('out', { stream: 'stdout', text }))
        child.stderr.setEncoding('utf8').on('data', text => emit('out', { stream: 'stderr', text }))
        signal.addEventListener('abort', () => { if (child.exitCode === null) child.kill('SIGTERM') }, { once: true })
        child.on('close', (code, killed) => {
          if (killed) emit('out', { stream: 'stderr', text: `boardd 那边的命令被信号 ${killed} 结束了\n` })
          emit('exit', { code: code ?? 1, download: null })
          end()
        })
        child.on('error', error => { emit('error', { message: error.message }); end() })
      })
    },
  }
}

/**
 * The frontends boardd serves. `uiDir` is one frontend (its index.html at the top), or several: a directory with
 * `frontends.json` (`{"default": "<name>", "frontends": [{"name", "title"}]}`) and each frontend in `<name>/`. Which one
 * boardd serves is boardd's setting `ui.frontend` (`GET /api/frontends` lists them, `POST /api/frontends?name=` picks
 * one for everyone), else the default; no cookie, so it works the same behind any proxy.
 */
export interface Frontends { default: string, frontends: Array<{ name: string, title: string }> }

export function readFrontends(uiDir: string | null): Frontends | null {
  if (!uiDir) return null
  try {
    const list = JSON.parse(readFileSync(join(uiDir, 'frontends.json'), 'utf8')) as Frontends
    const usable = list.frontends.filter(item => /^[A-Za-z0-9_-]{1,40}$/.test(item.name) && existsSync(join(uiDir, item.name, 'index.html')))
    if (!usable.length) return null
    return { default: usable.some(item => item.name === list.default) ? list.default : usable[0]!.name, frontends: usable }
  } catch { return null }
}

const FRONTEND_SETTING = 'ui.frontend'

function serveStatic(uiDir: string, pathname: string, response: ServerResponse) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1)
  const path = join(uiDir, file)
  if (file.includes('..') || !existsSync(path)) return send(response, 404, { error: 'not found' })
  response.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  response.end(readFileSync(path))
}

/** The page always listens on loopback; extra hosts (such as a Tailscale address) are opt-in. */
export async function serve(lab: BoardLab, options: ServeOptions): Promise<{ http: Server[], unix: Server, close(): Promise<void> }> {
  const listFrontends = () => readFrontends(options.uiDir)
  const current = (list: Frontends) => { const chosen = lab.kernel.setting(FRONTEND_SETTING); return chosen && list.frontends.some(item => item.name === chosen) ? chosen : list.default }
  const api = createApi(lab, { cli: options.cli, stateDir: options.stateDir, docsDir: options.docsDir, version: options.version, revision: options.revision })
  const human = `user:${userInfo().username}`
  const hosts = [...new Set(['127.0.0.1', ...(options.hosts ?? [])])]
  const allowed = new Set([...hosts, 'localhost'].map(host => `${host}:${options.port}`))
  const origins = new Set((options.origins ?? []).map(origin => origin.replace(/\/+$/, '')))

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    // Refuse rebinding hosts and cross-site writes.
    if (!allowed.has(request.headers.host ?? '')) return send(response, 403, { error: '不接受这个地址的访问' })
    const origin = request.headers.origin
    if (request.method !== 'GET' && origin && !allowed.has(origin.replace(/^https?:\/\//, '')) && !origins.has(origin)) return send(response, 403, { error: '拒绝跨站请求' })
    const pathname = new URL(request.url ?? '/', 'http://boardd').pathname
    // People on the page name themselves so several of them can queue for one board; the default is the local user.
    const name = String(request.headers[USER_HEADER] ?? '')
    const person = /^[A-Za-z0-9_.@-]{1,40}$/.test(name) ? `user:${name}` : human
    // A remote `boardlab` CLI (through a tunnel or a proxy) acts for an agent of that person: `claude:<session>` and the
    // like. It may not act as some other person.
    const agent = String(request.headers[HOLDER_HEADER] ?? '')
    if (agent && (!AGENT.test(agent) || (agent.startsWith('user:') && agent !== person))) return send(response, 403, { error: `不能以 ${agent} 的身份操作` })
    const holder = agent || person
    // Which frontends there are, which this browser has, and choosing one (it then reloads the page).
    if (pathname === '/api/frontends') {
      const list = listFrontends()
      if (request.method === 'POST') {
        const name = new URL(request.url ?? '/', 'http://boardd').searchParams.get('name') ?? ''
        if (!list?.frontends.some(item => item.name === name)) return send(response, 400, { error: `没有这个前端：${name}` })
        lab.kernel.setSetting(FRONTEND_SETTING, name)
        lab.kernel.record(holder, null, 'frontend', name, true, null)
        return send(response, 200, { current: name })
      }
      return send(response, 200, { ...(list ?? { default: null, frontends: [] }), current: list ? current(list) : null })
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) return void api(request, response, { holder, local: false })
    if (!options.uiDir) return send(response, 404, { error: '这个 boardd 不带网页（只有 /api）' })
    const frontends = readFrontends(options.uiDir)
    serveStatic(frontends ? join(options.uiDir, current(frontends)) : options.uiDir, pathname, response)
  }
  const unix = createServer((request, response) => {
    const holder = String(request.headers[HOLDER_HEADER] ?? human)
    void api(request, response, { holder, local: true })
  })

  const http: Server[] = []
  for (const host of hosts) {
    // A large file (a flash package) may take longer to send than Node's five-minute request limit.
    const server = createServer({ requestTimeout: 0 }, handle)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, host, resolve) })
    http.push(server)
  }
  // Under a supervisor the socket belongs to the workers together: the supervisor made its directory and removed a
  // stale one before the first worker started it.
  const ownSocket = options.ownSocket ?? true
  if (ownSocket && existsSync(options.socketPath)) unlinkSync(options.socketPath)
  await new Promise<void>(resolve => unix.listen(options.socketPath, resolve))
  if (ownSocket) chmodSync(options.socketPath, 0o600)
  const closeServer = (server: Server) => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) })
  return { http, unix, close: async () => { await Promise.all([...http, unix].map(closeServer)) } }
}
