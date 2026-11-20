/**
 * A boardd worker under a supervisor that owns the port and the socket (protocol 2, see supervisor.ts): it serves the
 * connections the supervisor hands it, reports what it is doing, and when drained finishes what it has before it exits.
 */
import type { Socket } from 'node:net'
import type { Handed, Requests, Stats, Took } from './supervisor.ts'

export interface Supervised {
  lab: { stop(): void, kernel: { busy: Map<string, unknown> } }
  accept(kind: Handed['kind'], socket: Socket): void
  connections(): number
  stopListening(): void
  closeIdle(): void
  endEvents(): void
  close(): Promise<void>
}

export interface WorkerOptions {
  version: string
  revision: string
  /** The requests this worker began (method and path) and has not reported yet, filled in as they come. */
  requests: string[]
  /** The V8 flags this release wants workers to run with here; those this process lacks are asked for in `ready`. */
  wanted: string[]
  /** How long a drained worker may keep connections before it exits anyway (default 6 hours). */
  drainCapMs?: number
  /** How often it reports its memory and connections (default 30 s). */
  statsMs?: number
  /** Where the supervisor's messages come from and go to (the process, by default). */
  channel?: Pick<NodeJS.Process, 'on' | 'send' | 'exit'>
}

/** A drained worker exits once nothing is left, but never while serving, before this cap. */
export const DRAIN_CAP_MS = 6 * 3_600_000

export function superviseWorker(boardd: Supervised, options: WorkerOptions) {
  const channel = options.channel ?? process
  const send = (message: object) => { try { channel.send?.(message) } catch { /* the supervisor went away */ } }
  // The requests go every second, so a crash's log line names what came just before it; memory every half minute.
  const requests = () => { const lines = options.requests.splice(0); if (lines.length) send({ type: 'requests', lines } satisfies Requests) }
  const report = () => {
    const memory = process.memoryUsage()
    send({ type: 'stats', rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, connections: boardd.connections(), busy: boardd.lab.kernel.busy.size } satisfies Stats)
    requests()
  }
  const timers = [setInterval(report, options.statsMs ?? 30_000), setInterval(requests, 1_000)]
  for (const timer of timers) timer.unref()

  let draining = false
  const drain = () => {
    if (draining) return
    draining = true
    report()
    // Background work stops and new connections go to the next worker; open connections and running tasks go on.
    boardd.lab.stop()
    boardd.stopListening()
    // Change notices are not work: their clients reconnect to the worker serving now.
    boardd.endEvents()
    const since = Date.now(), cap = options.drainCapMs ?? DRAIN_CAP_MS
    const check = () => {
      // A kept-alive connection with no request on it is not work: closed, so only streams and requests keep this one.
      boardd.closeIdle()
      const idle = boardd.connections() === 0 && boardd.lab.kernel.busy.size === 0
      if (!idle && Date.now() - since < cap) return
      clearInterval(timer)
      if (!idle) console.error(`boardd worker ${process.pid}: still ${boardd.connections()} connections and ${boardd.lab.kernel.busy.size} tasks after ${Math.round(cap / 60_000)} minutes of draining; exiting`)
      void boardd.close().finally(() => channel.exit(0))
    }
    const timer = setInterval(check, 2_000)
    check()
  }

  channel.on('message', (message: unknown, socket?: unknown) => {
    const type = (message as { type?: string } | undefined)?.type
    if (type === 'conn' && socket) {
      // A drained worker is handed nothing new; one that came anyway (sent as it drained) is served all the same.
      boardd.accept((message as Handed).kind, socket as Socket)
      send({ type: 'took', id: (message as Handed).id } satisfies Took)
    } else if (type === 'drain') drain()
  })
  // The supervisor gone: nothing hands this worker connections any more, so it ends like a drained one.
  channel.on('disconnect', drain)
  const missing = options.wanted.filter(flag => !process.execArgv.includes(flag))
  send({ type: 'ready', version: options.version, revision: options.revision, handed: true, ...(missing.length ? { execArgv: missing } : {}) })
  return { drain, report, stop: () => { for (const timer of timers) clearInterval(timer) } }
}
