/**
 * boardlab's API, independent of any transport: each endpoint is a method and a path with a handler, contributed by the
 * core or a module. The HTTP gateway serves them all (JSON in and out, event streams as SSE, files as bytes); another
 * front end can serve the same endpoints its own way. `GET /api` lists them.
 */
import { BoardError } from './errors.ts'

/** Who calls: a holder (`user:<name>`, or an agent of one), over the local socket or not. */
export interface Caller { holder: string, local: boolean }

export interface ApiRequest {
  /** The JSON body (POST), or {}. */
  body: any
  query: URLSearchParams
  /** Path parameters (`/api/files/:sha256`); `*` is the rest of a path that ends in `/*`, as sent (`/a/b`, or ''). */
  params: Record<string, string>
  /** The request's headers, lower-case, for endpoints that pass a request on (absent where there are none). */
  headers?: Record<string, string | string[] | undefined>
  caller: Caller
  /** Aborted when the caller goes away. */
  signal: AbortSignal
  /** The body as it arrives, for endpoints that take raw bytes (`body: 'raw'`). */
  upload: AsyncIterable<Buffer> | null
}

export type Emit = (event: string, data: unknown) => void

/** A reply sent as events as they happen, until `end` (or the caller leaving, which aborts `signal`). */
export class EventStream {
  constructor(readonly start: (emit: Emit, end: () => void, signal: AbortSignal) => void | Promise<void>) {}
}
/** A reply of plain text rather than JSON. */
export class TextReply {
  /** `filename`: offered as a download under this name (Content-Disposition: attachment). */
  constructor(readonly text: string, readonly type = 'text/plain; charset=utf-8', readonly filename?: string) {}
}
/** A reply passed on as it came from elsewhere: its status, headers and body, streamed (a proxied page or event stream). */
export class RawReply {
  constructor(readonly status: number, readonly headers: Record<string, string>, readonly body: AsyncIterable<Buffer | string> | null) {}
}
/** A reply that is a file's bytes. */
export class FileReply {
  constructor(readonly path: string) {}
}

export type Method = 'GET' | 'POST' | 'PUT'

export interface Endpoint {
  method: Method
  /** `/api/...`, with `:name` for a path parameter, and ending in `/*` to take every path below it too (`params['*']`). */
  path: string
  /** What it does, for `GET /api`. */
  about: string
  /** What the body is: JSON (the default for POST) or raw bytes (the default for PUT). */
  body?: 'json' | 'raw'
  /** Returns the reply: JSON data (undefined is `{ok: true}`), or a TextReply, FileReply, RawReply or EventStream. */
  handle(request: ApiRequest): unknown
}

interface Registered extends Endpoint { module: string, pattern: RegExp, keys: string[] }

export class Api {
  private readonly endpoints: Registered[] = []

  /** Add a module's endpoints; a method and path may be served once. */
  add(module: string, endpoints: Endpoint[]) {
    for (const endpoint of endpoints) {
      if (!/^\/api(\/[A-Za-z0-9_.:-]+)*(\/\*)?$/.test(endpoint.path)) throw new Error(`endpoint path ${endpoint.path}`)
      if (this.endpoints.some(item => item.method === endpoint.method && item.path === endpoint.path)) throw new Error(`${endpoint.method} ${endpoint.path} is served twice`)
      const keys: string[] = []
      const rest = endpoint.path.endsWith('/*')
      const fixed = rest ? endpoint.path.slice(0, -2) : endpoint.path
      const pattern = new RegExp(`^${fixed.replace(/[.]/g, '\\.').replace(/:([A-Za-z0-9_]+)/g, (_, key: string) => { keys.push(key); return '([^/]+)' })}${rest ? '(/.*)?' : ''}$`)
      if (rest) keys.push('*')
      this.endpoints.push({ ...endpoint, module, pattern, keys })
    }
  }

  match(method: string, path: string): { endpoint: Registered, params: Record<string, string> } | null {
    for (const endpoint of this.endpoints) {
      if (endpoint.method !== method) continue
      const found = path.match(endpoint.pattern)
      if (found) return { endpoint, params: Object.fromEntries(endpoint.keys.map((key, index) => [key, key === '*' ? found[index + 1] ?? '' : decodeURIComponent(found[index + 1]!)])) }
    }
    return null
  }

  list(): Array<{ method: Method, path: string, about: string, module: string }> {
    return this.endpoints.map(({ method, path, about, module }) => ({ method, path, about, module }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  }
}

/** A required string parameter. */
export function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new BoardError('invalid', `缺少参数 ${name}`)
  return value
}

export function optional(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
