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
 */
import cluster from 'node:cluster'
import type { Worker } from 'node:cluster'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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
}

interface Ready { type: 'ready', version: string, revision: string }
interface Drain { type: 'drain' }

const isReady = (message: unknown): message is Ready => (message as Ready | undefined)?.type === 'ready'

export async function supervise(options: SupervisorOptions): Promise<void> {
  if (!cluster.isPrimary) throw new Error('the supervisor runs in the primary process only')
  const { stateDir, cli, args } = options
  const pidFile = join(stateDir, 'supervisor.pid')
  const updateFile = join(stateDir, 'update.json')
  const servingFile = join(stateDir, 'serving.json')
  const socketPath = socketPathFor(stateDir)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(pidFile, `${process.pid}\n`)
  // A socket left by a boardd that did not stop cleanly: the first worker makes the socket every worker shares.
  if (existsSync(socketPath)) unlinkSync(socketPath)
  // New connections go to workers in turn; an old worker that stops accepting takes no new ones.
  cluster.schedulingPolicy = cluster.SCHED_RR
  const workerArgs = ['serve', '--worker', ...args]
  const env = { ...process.env, BOARDLAB_SUPERVISED: '1', BOARDLAB_SUPERVISOR_PID: String(process.pid) }
  const setup = (exec: string) => (cluster as unknown as { setupPrimary(options: { exec: string, args: string[], execArgv: string[], silent: boolean }): void })
    .setupPrimary({ exec, args: workerArgs, execArgv: process.execArgv, silent: false })

  let stopping = false, updating = false
  let latestCli = cli
  let current: Worker | null = null
  // Workers an update has finished with: they keep their connections and tasks, and their exit is not a crash.
  const retired = new WeakSet<Worker>()

  const serve = (message: Ready) => {
    writeFileSync(servingFile, JSON.stringify({ version: message.version, revision: message.revision, pid: current?.process.pid ?? null, at: new Date().toISOString() }) + '\n')
    // The first worker made the shared socket; keep it to this user, as a boardd of its own would.
    try { if (existsSync(socketPath)) chmodSync(socketPath, 0o600) } catch { /* the socket went away with the worker */ }
    console.log(`boardd worker ${current?.process.pid ?? '?'} is serving ${message.version} (${message.revision})`)
  }

  const fork = (exec: string, what: string): Worker => {
    setup(exec)
    latestCli = exec
    const worker = cluster.fork(env)
    worker.on('message', message => { if (isReady(message)) { current = worker; serve(message) } })
    worker.on('exit', (code, signal) => {
      if (current === worker) current = null
      // An old generation going away once its last connection ended, or a worker the update replaced: not a crash.
      if (stopping || retired.has(worker)) return
      if (updating) return
      console.error(`boardd worker ${worker.process.pid} (${what}) exited (${signal ?? code}); starting another`)
      fork(latestCli, 'replacement')
    })
    return worker
  }

  const waitReady = (worker: Worker, timeoutMs = 90_000): Promise<void> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.removeListener('message', onMessage); worker.removeListener('exit', onExit); reject(new Error('the new worker did not become ready')) }, timeoutMs)
    const onMessage = (message: unknown) => { if (isReady(message)) { clearTimeout(timer); worker.removeListener('message', onMessage); worker.removeListener('exit', onExit); resolve() } }
    const onExit = () => { clearTimeout(timer); worker.removeListener('message', onMessage); worker.removeListener('exit', onExit); reject(new Error(`the new worker exited (${worker.process.pid}) before it was ready`)) }
    worker.on('message', onMessage); worker.once('exit', onExit)
  })

  const handover = async () => {
    if (updating || stopping) return
    updating = true
    try {
      const update = JSON.parse(readFileSync(updateFile, 'utf8')) as { release?: string, version?: string, revision?: string }
      const nextCli = update.release ? join(update.release, 'dist/cli.js') : ''
      if (!nextCli || !existsSync(nextCli)) throw new Error(`${nextCli || update.release || 'the release'} has no dist/cli.js`)
      const worker = fork(nextCli, 'update')
      await waitReady(worker)
      for (const old of Object.values(cluster.workers ?? {})) {
        if (!old || old.id === worker.id) continue
        retired.add(old)
        old.send({ type: 'drain' } satisfies Drain)
        old.disconnect()
      }
      unlinkSync(updateFile)
      const version = update.version ?? '?', revision = update.revision ?? '?'
      console.log(`updated to ${version} (${revision}); older workers stay for their connections and tasks`)
    } catch (error) {
      console.error(`update failed, still serving the old version: ${(error as Error).message}`)
    } finally { updating = false }
  }

  process.on('SIGUSR2', () => { void handover() })
  const stop = () => {
    if (stopping) return
    stopping = true
    for (const worker of Object.values(cluster.workers ?? {})) { worker?.send({ type: 'drain' } satisfies Drain); worker?.disconnect() }
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)

  fork(latestCli, 'first')
  console.log(`boardd supervisor ${process.pid}${options.version ? ` (${options.version} ${options.revision})` : ''} for ${stateDir}`)
}
