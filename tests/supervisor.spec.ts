import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { exitLine, keepCore, SHARED_DATABASE_ENV, workerEnv, workerExecArgv } from '../src/server/supervisor.ts'
import { superviseWorker } from '../src/server/worker.ts'

describe('supervisor workers', () => {
  it('start without the unstable V8 tiers on riscv64 only, and take their flags from BOARDLAB_WORKER_NODE_FLAGS when set', () => {
    expect(workerExecArgv('riscv64', {}, [])).toEqual(['--single-threaded', '--no-sparkplug', '--no-maglev'])
    // The supervisor's own flags (the unit's --no-sparkplug) are kept and not repeated.
    expect(workerExecArgv('riscv64', {}, ['--no-sparkplug'])).toEqual(['--no-sparkplug', '--single-threaded', '--no-maglev'])
    expect(workerExecArgv('x64', {}, ['--inspect'])).toEqual(['--inspect'])
    expect(workerExecArgv('riscv64', { BOARDLAB_WORKER_NODE_FLAGS: '--no-opt  --no-opt' }, [])).toEqual(['--no-opt'])
    expect(workerExecArgv('riscv64', { BOARDLAB_WORKER_NODE_FLAGS: '' }, ['--no-sparkplug'])).toEqual(['--no-sparkplug'])
    expect(workerExecArgv('x64', { BOARDLAB_WORKER_NODE_FLAGS: '--no-maglev' }, [])).toEqual(['--no-maglev'])
  })

  it('are marked as sharing the database when another worker is still alive, so only a first start restores it', () => {
    const live = { isDead: () => false }, dead = { isDead: () => true }
    expect(workerEnv({ A: '1' }, [])).toEqual({ A: '1', [SHARED_DATABASE_ENV]: '0' })
    expect(workerEnv({}, [dead])[SHARED_DATABASE_ENV]).toBe('0')
    expect(workerEnv({}, [dead, live])[SHARED_DATABASE_ENV]).toBe('1')
  })
})

describe('a worker exit', () => {
  it('is logged with its uptime, last memory and connections, and its last requests', () => {
    const seen = { started: 0, what: 'first', release: '0.1.0-abc', stats: { type: 'stats' as const, rss: 150 * 1048576, heapUsed: 40 * 1048576, heapTotal: 60 * 1048576, connections: 7, busy: 1 }, requests: ['GET /api/state', 'GET /api/events'] }
    expect(exitLine(42, seen, 'SIGSEGV', 180_000)).toBe('boardd worker 42 (first, 0.1.0-abc) exited (SIGSEGV) after 3m; last seen rss 150 MB, heap 40 MB/60 MB, 7 connections, 1 running; last requests: GET /api/state, GET /api/events')
    expect(exitLine(undefined, { ...seen, stats: null, requests: [] }, 'code 1', 5_000)).toBe('boardd worker ? (first, 0.1.0-abc) exited (code 1) after 5s; it never reported')
  })

  it('keeps its core file under the worker\'s name in a cores directory only, the newest two', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'boardlab-cores-')), 'cores')
    mkdirSync(dir)
    try {
      expect(keepCore(dir, 1, 0)).toBeNull()
      const kept: string[] = []
      for (const pid of [1, 2, 3]) {
        writeFileSync(join(dir, 'core'), 'x')
        const file = keepCore(dir, pid, 0)!
        expect(file).toMatch(new RegExp(`/core\\.${pid}\\.`))
        utimesSync(file, pid, pid)
        kept.push(file)
      }
      expect(readdirSync(dir).length).toBe(2)
      expect(existsSync(kept[0]!)).toBe(false)
      // Elsewhere (boardd not started in a cores directory) nothing is touched.
      const other = dirname(dir)
      writeFileSync(join(other, 'core'), 'x')
      expect(keepCore(other, 4, 0)).toBeNull()
      expect(existsSync(join(other, 'core'))).toBe(true)
    } finally { rmSync(dirname(dir), { recursive: true, force: true }) }
  })
})

describe('a supervised worker', () => {
  function fake() {
    const sent: Array<Record<string, unknown>> = [], exits: number[] = [], handlers = new Map<string, (...args: unknown[]) => void>()
    const state = { connections: 2, busy: new Map<string, unknown>([['b1', {}]]), accepted: [] as string[], stopped: false, closed: false, ended: false }
    const boardd = {
      lab: { stop: () => { state.stopped = true }, kernel: { busy: state.busy } },
      accept: (kind: string) => { state.accepted.push(kind) }, connections: () => state.connections,
      stopListening: () => {}, closeIdle: () => {}, endEvents: () => { state.ended = true },
      close: async () => { state.closed = true },
    }
    const channel = { on: (event: string, fn: (...args: unknown[]) => void) => { handlers.set(event, fn); return channel }, send: (message: Record<string, unknown>) => { sent.push(message); return true }, exit: (code: number) => { exits.push(code) } }
    return { sent, exits, handlers, state, boardd, channel }
  }

  it('says it takes handed connections and which flags it lacks, serves what it is handed, and drains only once idle', async () => {
    vi.useFakeTimers()
    try {
      const { sent, exits, handlers, state, boardd, channel } = fake()
      superviseWorker(boardd as never, { version: '1', revision: 'r', requests: ['GET /api/state'], wanted: ['--no-such-flag'], channel: channel as never, drainCapMs: 60_000 })
      expect(sent[0]).toEqual({ type: 'ready', version: '1', revision: 'r', handed: true, execArgv: ['--no-such-flag'] })
      handlers.get('message')!({ type: 'conn', kind: 'unix', id: 7 }, {})
      expect(state.accepted).toEqual(['unix'])
      expect(sent.at(-1)).toEqual({ type: 'took', id: 7 })
      handlers.get('message')!({ type: 'drain' })
      expect(state.stopped && state.ended).toBe(true)
      expect(sent.some(message => message.type === 'stats')).toBe(true)
      expect(sent.find(message => message.type === 'requests')).toEqual({ type: 'requests', lines: ['GET /api/state'] })
      // Still a connection and a task: it stays.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(exits).toEqual([])
      state.busy.clear(); state.connections = 0
      await vi.advanceTimersByTimeAsync(2_000)
      expect(state.closed).toBe(true)
      expect(exits).toEqual([0])
    } finally { vi.useRealTimers() }
  })

  it('exits at the drain cap even while something is still open', async () => {
    vi.useFakeTimers()
    try {
      const { exits, handlers, boardd, channel } = fake()
      superviseWorker(boardd as never, { version: '1', revision: 'r', requests: [], wanted: [], channel: channel as never, drainCapMs: 30_000 })
      handlers.get('message')!({ type: 'drain' })
      await vi.advanceTimersByTimeAsync(28_000)
      expect(exits).toEqual([])
      await vi.advanceTimersByTimeAsync(4_000)
      expect(exits).toEqual([0])
    } finally { vi.useRealTimers() }
  })

  it('asks the supervisor for a worker started now when what it loads changed, and says why', () => {
    const { sent, handlers, boardd, channel } = fake()
    const worker = superviseWorker(boardd as never, { version: '1', revision: 'r', requests: [], wanted: [], channel: channel as never })
    // The market's page installed a module: this worker's configuration is out of date, and only one started now has it.
    worker.reload('a module was installed')
    expect(sent.at(-1)).toEqual({ type: 'reload', why: 'a module was installed' })
    // It is a request, not a drain: this worker keeps serving until the supervisor hands over.
    expect(sent.some(message => message.type === 'drain')).toBe(false)
    expect(handlers.size).toBeGreaterThan(0)
  })
})
