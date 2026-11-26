/**
 * boardd's supervisor: one stable process that owns the listening socket and port and runs boardd workers in
 * generations. An update starts a worker from the new release, waits for it to answer, and only then stops the old
 * worker accepting new connections: new requests, pages and CLIs reach the new version, while the old worker keeps the
 * connections it already has (a console stream, an event stream) and the tasks it is running until they end. Locks and
 * everything else live in the SQLite database both workers share, and a running task holds its board's lock, so the new
 * worker refuses to do something else to that board until the old one finishes.
 *
 * The supervisor comes from the release that first started it. It speaks a small, versioned update message, so later
 * releases hand it a worker of their own without replacing it:
 *
 *   <state>/update.json   {"release": "<…>/releases/<version>-<revision>", "version": "…", "revision": "…"}
 *   kill -USR2 <pid in <state>/supervisor.pid>
 *   <state>/serving.json  the version and revision now serving (the update waits for it to change)
 *
 * A supervisor that speaks protocol 2 (`BOARDLAB_SUPERVISOR_PROTOCOL` in a worker's environment) listens on the port
 * and the socket itself and hands each connection to the worker serving (`{type: 'conn'}` with the socket). While no
 * worker is ready (one crashed, its replacement is starting) connections wait in a queue instead of being refused.
 * Workers report what they last saw (`stats`, `requests`) so a worker's exit is logged with its uptime, memory,
 * connections and last requests. A worker from an older supervisor listens through the cluster module as before.
 */
import cluster from 'node:cluster'
import type { Worker } from 'node:cluster'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { socketPathFor } from '../shared/client.ts'

export interface SupervisorOptions {
  stateDir: string
  /** The CLI file workers run (`…/dist/cli.js`). */
  cli: string
  /** The arguments after `serve`, without `--supervisor`/`--worker`. */
  args: string[]
  /** This supervisor's own release, for the first worker and for logs. */
  version?: string
  revision?: string
  /** The port and the addresses to listen on (loopback first); the supervisor owns them and hands connections over. */
  port: number
  hosts: string[]
}

/** A worker serving: `handed` when it takes connections from this supervisor, `execArgv` the flags it lacks. */
interface Ready { type: 'ready', version: string, revision: string, handed?: boolean, execArgv?: unknown[] }
interface Drain { type: 'drain' }
/** A connection for the worker to serve, sent with its socket. */
export interface Handed { type: 'conn', kind: 'http' | 'unix', id: number }
/** The worker's answer once it has a handed connection. */
export interface Took { type: 'took', id: number }
/** What a worker reports every half minute, and the requests it began (method and path) since its last report. */
export interface Stats { type: 'stats', rss: number, heapUsed: number, heapTotal: number, connections: number, busy: number }
export interface Requests { type: 'requests', lines: string[] }
/**
 * A worker asking for a new one of the same release: what it did changed what a boardd loads (a module was installed
 * or taken out), and only a worker started after that has it. The next worker serves; this one finishes what it has.
 */
export interface Reload { type: 'reload', why?: string }

const isReady = (message: unknown): message is Ready => (message as Ready | undefined)?.type === 'ready'

/** Set in a worker's environment by a supervisor that hands connections over: its protocol, and the port it listens on. */
export const SUPERVISOR_PROTOCOL_ENV = 'BOARDLAB_SUPERVISOR_PROTOCOL'
export const SUPERVISOR_PORT_ENV = 'BOARDLAB_SUPERVISOR_PORT'
/** How long connections wait for a worker to be ready before they are closed, and how many may wait. */
const QUEUE_MS = 60_000, QUEUE_MAX = 1000
/** Core files kept in `<state>/cores` when boardd runs there (setup.sh --core-dumps): the newest few. */
const CORES_KEPT = 2

/**
 * Set to `1` for a worker started while another one is still alive (an update's new worker beside the old one, a
 * replacement while retired workers finish their connections): it shares the database with that one, so it must not
 * move a damaged file aside and restore a copy under it. It refuses to start instead, and the live one keeps serving.
 */
export const SHARED_DATABASE_ENV = 'BOARDLAB_SHARED_DATABASE'

/** The environment for a new worker: whether any other worker is still alive decides whether it shares the database. */
export function workerEnv(base: NodeJS.ProcessEnv, others: Array<{ isDead(): boolean }>): NodeJS.ProcessEnv {
  return { ...base, [SHARED_DATABASE_ENV]: others.some(worker => !worker.isDead()) ? '1' : '0' }
}

/**
 * The V8 flags a worker runs with: the supervisor's own, plus what the machine needs.
 *
 * On RISC-V, Node's V8 is not stable in every tier. A worker segfaulted under large request bodies (a 99-200 MB
 * upload killed it every time, while the same work on x86 and in a bare `node` server on the same board was fine);
 * `--single-threaded` (no background GC/compiler threads) kept it up. Long-running workers also crashed every 10-30
 * minutes in JIT-compiled code; the baseline compiler (Sparkplug) and the mid-tier optimizer (Maglev) are the tiers
 * they died in, so workers there run without both and keep the interpreter and TurboFan.
 *
 * `BOARDLAB_WORKER_NODE_FLAGS` (space-separated) replaces those machine defaults, for trying other flags without a
 * release; set it empty to run workers with only the supervisor's flags. A flag already given is not repeated.
 */
export const RISCV64_WORKER_FLAGS = ['--single-threaded', '--no-sparkplug', '--no-maglev']

export function workerExecArgv(arch: string = process.arch, env: NodeJS.ProcessEnv = process.env, execArgv: string[] = process.execArgv): string[] {
  const override = env.BOARDLAB_WORKER_NODE_FLAGS
  const wanted = override !== undefined ? override.split(/\s+/).filter(Boolean) : arch === 'riscv64' ? RISCV64_WORKER_FLAGS : []
  return [...execArgv, ...wanted.filter((flag, index) => !execArgv.includes(flag) && wanted.indexOf(flag) === index)]
}


/** What the supervisor last heard from a worker, for the line it logs when the worker exits. */
interface Seen { started: number, what: string, release: string, stats: Stats | null, requests: string[] }

const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`
const age = (ms: number) => ms < 120_000 ? `${Math.round(ms / 1000)}s` : ms < 7_200_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`

/** One line about a worker that went away: how long it ran, its memory and connections when it last reported, its last requests. */
export function exitLine(pid: number | undefined, seen: Seen, how: string, now = Date.now()): string {
  const stats = seen.stats
  return `boardd worker ${pid ?? '?'} (${seen.what}, ${seen.release}) exited (${how}) after ${age(now - seen.started)}`
    + (stats ? `; last seen rss ${mb(stats.rss)}, heap ${mb(stats.heapUsed)}/${mb(stats.heapTotal)}, ${stats.connections} connections, ${stats.busy} running` : '; it never reported')
    + (seen.requests.length ? `; last requests: ${seen.requests.join(', ')}` : '')
}

/**
 * A core file the kernel wrote into this directory for a crashed worker (core_pattern `core`, boardd started in
 * `<state>/cores` by setup.sh --core-dumps): renamed after the worker, the newest few kept. Elsewhere nothing is touched.
 */
export function keepCore(dir: string, pid: number | undefined, since: number): string | null {
  if (!/\/cores\/?$/.test(dir)) return null
  const file = join(dir, 'core')
  try {
    if (statSync(file).mtimeMs < since) return null
    const kept = join(dir, `core.${pid ?? 'unknown'}.${new Date().toISOString().replace(/[:.]/g, '-')}`)
    renameSync(file, kept)
    const old = readdirSync(dir).filter(name => name.startsWith('core.')).map(name => join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(CORES_KEPT)
    for (const path of old) unlinkSync(path)
    return kept
  } catch { return null }
}

export async function supervise(options: SupervisorOptions): Promise<void> {
  if (!cluster.isPrimary) throw new Error('the supervisor runs in the primary process only')
  const { stateDir, cli, args } = options
  const pidFile = join(stateDir, 'supervisor.pid')
  const updateFile = join(stateDir, 'update.json')
  const servingFile = join(stateDir, 'serving.json')
  const socketPath = socketPathFor(stateDir)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(pidFile, `${process.pid}\n`)
  // A socket left by a boardd that did not stop cleanly.
  if (existsSync(socketPath)) unlinkSync(socketPath)
  const workerArgs = ['serve', '--worker', ...args]
  const env = { ...process.env, BOARDLAB_SUPERVISED: '1', BOARDLAB_SUPERVISOR_PID: String(process.pid), [SUPERVISOR_PROTOCOL_ENV]: '2', [SUPERVISOR_PORT_ENV]: String(options.port) }
  // Flags a release's workers asked for beyond the supervisor's own (`ready.execArgv`): its next workers start with them.
  const asked = new Map<string, string[]>()
  const setup = (exec: string) => (cluster as unknown as { setupPrimary(options: { exec: string, args: string[], execArgv: string[], silent: boolean }): void })
    .setupPrimary({ exec, args: workerArgs, execArgv: [...new Set([...workerExecArgv(), ...(asked.get(exec) ?? [])])], silent: false })

  let stopping = false, updating = false
  let latestCli = cli
  let current: Worker | null = null
  // Workers an update has finished with: they keep their connections and tasks, and their exit is not a crash.
  const retired = new WeakSet<Worker>()
  const seen = new WeakMap<Worker, Seen>()

  // The port and the socket are the supervisor's: a worker going away never closes them. A connection that comes while
  // no worker is ready waits for the next one.
  const queue: Array<{ socket: Socket, kind: Handed['kind'], at: number }> = []
  // Handed but not yet taken: the supervisor keeps its copy of each socket until the worker says it has it, so one
  // handed to a worker that is dying (it crashed, the exit not yet seen) goes to the next worker instead of hanging.
  const pending = new Map<Worker, Map<number, { socket: Socket, kind: Handed['kind'], at: number }>>()
  let handed = 0
  const hand = (socket: Socket, kind: Handed['kind'], at = Date.now()) => {
    const worker = current
    if (!worker || !worker.isConnected()) {
      if (queue.length >= QUEUE_MAX) return void socket.destroy()
      return void queue.push({ socket, kind, at })
    }
    const id = ++handed
    const mine = pending.get(worker) ?? new Map()
    pending.set(worker, mine)
    mine.set(id, { socket, kind, at })
    worker.send({ type: 'conn', kind, id } satisfies Handed, socket as never, { keepOpen: true }, (error: Error | null) => {
      if (!error || !mine.delete(id) || socket.destroyed) return
      // The worker went away as it was handed this one: the next worker serves it.
      if (current === worker) current = null
      queue.push({ socket, kind, at })
    })
  }
  /** The worker has the connection: the supervisor's copy is closed (the connection stays open in the worker). */
  const taken = (worker: Worker, id: number) => { const item = pending.get(worker)?.get(id); if (!item) return; pending.get(worker)!.delete(id); item.socket.destroy() }
  /** A worker gone: what it was handed and had not taken waits for the next one. */
  const orphaned = (worker: Worker) => {
    const mine = pending.get(worker)
    pending.delete(worker)
    if (current === worker) current = null
    for (const item of mine?.values() ?? []) if (!item.socket.destroyed) queue.push(item)
    if (current) flush()
  }
  const flush = () => {
    const now = Date.now()
    for (const item of queue.splice(0)) {
      if (item.socket.destroyed) continue
      if (now - item.at > QUEUE_MS) item.socket.destroy()
      else hand(item.socket, item.kind, item.at)
    }
  }
  setInterval(() => { if (!current) flush() }, 5_000).unref()
  const listen = (server: Server, where: () => void) => new Promise<void>((resolve, reject) => { server.once('error', reject); where(); server.once('listening', () => { server.off('error', reject); resolve() }) })
  const accepting = (kind: Handed['kind']) => {
    const server = createServer({ pauseOnConnect: true }, socket => { socket.on('error', () => socket.destroy()); hand(socket, kind) })
    server.on('error', error => console.error(`boardd supervisor: ${kind} listener: ${error.message}`))
    return server
  }
  const servers: Server[] = []
  for (const host of [...new Set(['127.0.0.1', ...options.hosts])]) {
    const server = accepting('http')
    await listen(server, () => server.listen(options.port, host))
    servers.push(server)
  }
  const unix = accepting('unix')
  await listen(unix, () => unix.listen(socketPath))
  chmodSync(socketPath, 0o600)
  servers.push(unix)

  const serve = (message: Ready) => {
    // What serves is told by the log line too; a state directory that cannot be written must not stop the handover.
    try { writeFileSync(servingFile, JSON.stringify({ version: message.version, revision: message.revision, pid: current?.process.pid ?? null, at: new Date().toISOString() }) + '\n') }
    catch (error) { console.error(`boardd: could not write ${servingFile}: ${(error as Error).message}`) }
    console.log(`boardd worker ${current?.process.pid ?? '?'} is serving ${message.version} (${message.revision})`)
    flush()
  }

  const fork = (exec: string, what: string): Worker => {
    setup(exec)
    const worker = cluster.fork(workerEnv(env, Object.values(cluster.workers ?? {}).filter((item): item is Worker => !!item)))
    const record: Seen = { started: Date.now(), what, release: exec.replace(/\/dist\/cli\.js$/, '').split('/').pop() ?? exec, stats: null, requests: [] }
    seen.set(worker, record)
    let ready = false
    worker.on('message', message => {
      const type = (message as { type?: string } | undefined)?.type
      if (type === 'took') taken(worker, (message as Took).id)
      else if (type === 'stats') record.stats = message as Stats
      else if (type === 'requests') record.requests = [...record.requests, ...(message as Requests).lines].slice(-8)
      else if (type === 'reload' && worker === current && !updating && !stopping) {
        // Same release, same CLI: a worker started now loads what the configuration says now.
        console.log(`boardd: ${(message as Reload).why ?? 'the configuration changed'}; starting a new worker`)
        updating = true
        void replaceWith(exec, 'reload')
          .then(() => console.log('boardd: the new worker serves; the old one finishes what it has'))
          .catch(error => console.error(`boardd: could not reload: ${(error as Error).message}`))
          .finally(() => { updating = false; ensure() })
      }
      else if (isReady(message)) {
        // A worker that cannot take handed connections (a release older than this supervisor) would listen itself,
        // on the port this process holds: it is not given any.
        if (!message.handed) { console.error(`boardd worker ${worker.process.pid} (${exec}) does not take connections from this supervisor; stopping it`); worker.kill(); return }
        ready = true; current = worker; latestCli = exec; serve(message)
        // Flags its release wants on this machine that this supervisor did not start it with: its later workers get
        // them, and this one is replaced by one that has them, once.
        const missing = Array.isArray(message.execArgv) ? message.execArgv.filter((flag): flag is string => typeof flag === 'string' && /^--[\w-]+(=\S*)?$/.test(flag)) : []
        if (missing.length && !asked.has(exec)) { asked.set(exec, missing); setImmediate(() => { void refresh(worker, exec) }) }
      }
    })
    worker.on('disconnect', () => orphaned(worker))
    worker.on('exit', (code, signal) => {
      orphaned(worker)
      const how = signal ?? `code ${code}`
      const core = signal ? keepCore(process.cwd(), worker.process.pid, record.started) : null
      if (stopping || retired.has(worker)) {
        if (!stopping) console.log(exitLine(worker.process.pid, record, how) + (core ? `; core file ${core}` : ''))
        return
      }
      console.error(exitLine(worker.process.pid, record, how) + (core ? `; core file ${core}` : '') + (updating ? '' : '; starting another'))
      if (updating) return
      // One that never came up (a database it may not restore while retired workers still use it) is not retried at
      // once: the next try comes when they may have gone.
      if (ready) fork(latestCli, 'replacement')
      else setTimeout(() => { if (!stopping && !updating) fork(latestCli, 'replacement') }, 5_000).unref()
    })
    return worker
  }

  const waitReady = (worker: Worker, timeoutMs = 90_000): Promise<void> => new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); worker.removeListener('message', onMessage); worker.removeListener('exit', onExit) }
    const timer = setTimeout(() => { done(); reject(new Error('the new worker did not become ready')) }, timeoutMs)
    const onMessage = (message: unknown) => {
      if (!isReady(message)) return
      done()
      if (message.handed) resolve(); else reject(new Error('the new release does not take connections from this supervisor (it is older)'))
    }
    const onExit = () => { done(); reject(new Error(`the new worker exited (${worker.process.pid}) before it was ready`)) }
    worker.on('message', onMessage); worker.once('exit', onExit)
  })

  /** Start a worker of `nextCli`; once it serves, the others finish what they have and exit. */
  const replaceWith = async (nextCli: string, what: string) => {
    const worker = fork(nextCli, what)
    try { await waitReady(worker) } catch (error) { if (!worker.isDead()) { retired.add(worker); worker.kill() } throw error }
    for (const old of Object.values(cluster.workers ?? {})) {
      if (!old || old.id === worker.id || old.isDead()) continue
      retired.add(old)
      old.send({ type: 'drain' } satisfies Drain)
    }
  }

  // A worker that died while an update or a restart was starting its replacement, which then failed too: nothing
  // would serve, so one more of the release serving last is started.
  const ensure = () => {
    if (stopping || current) return
    if (Object.values(cluster.workers ?? {}).some(worker => worker && !worker.isDead() && !retired.has(worker))) return
    fork(latestCli, 'replacement')
  }

  const handover = async () => {
    if (updating || stopping) return
    updating = true
    try {
      const update = JSON.parse(readFileSync(updateFile, 'utf8')) as { release?: string, version?: string, revision?: string }
      const nextCli = update.release ? join(update.release, 'dist/cli.js') : ''
      if (!nextCli || !existsSync(nextCli)) throw new Error(`${nextCli || update.release || 'the release'} has no dist/cli.js`)
      await replaceWith(nextCli, 'update')
      unlinkSync(updateFile)
      console.log(`updated to ${update.version ?? '?'} (${update.revision ?? '?'}); older workers exit once their connections and tasks end`)
    } catch (error) {
      console.error(`update failed, still serving the old version: ${(error as Error).message}`)
    } finally { updating = false; ensure() }
  }

  // A worker that asked for flags it was not started with (its release knows its machine better than this
  // supervisor): replaced once by one that has them.
  const refresh = async (worker: Worker, exec: string) => {
    if (updating || stopping || current !== worker) return
    updating = true
    try { await replaceWith(exec, 'flags'); console.log(`boardd workers of ${exec} now run with ${asked.get(exec)?.join(' ')}`) }
    catch (error) { console.error(`could not restart the worker with its flags: ${(error as Error).message}`) }
    finally { updating = false; ensure() }
  }
  process.on('SIGUSR2', () => { void handover() })
  const stop = () => {
    if (stopping) return
    stopping = true
    for (const server of servers) server.close()
    for (const item of queue.splice(0)) item.socket.destroy()
    // Disconnected, not killed: each finishes the connections and tasks it has, then exits.
    for (const worker of Object.values(cluster.workers ?? {})) { worker?.send({ type: 'drain' } satisfies Drain); worker?.disconnect() }
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)

  fork(latestCli, 'first')
  console.log(`boardd supervisor ${process.pid}${options.version ? ` (${options.version} ${options.revision})` : ''} for ${stateDir}, listening on ${options.port}`)
}
