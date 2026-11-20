/**
 * The supervisor with real worker processes: two builds of a test distribution (tests/fixtures/supervised.ts, a fake
 * module with a long stream), an update handed over while a stream is open, and a worker crash while clients connect.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { get, type IncomingMessage } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const core = resolve(import.meta.dirname, '..')
let root: string, state: string, port: number, supervisor: ChildProcess, log = ''

const freePort = () => new Promise<number>(done => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => done(port)) }) })
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const serving = () => { try { return JSON.parse(readFileSync(join(state, 'serving.json'), 'utf8')) as { revision: string, pid: number } } catch { return null } }
async function until<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${log}`)
    await sleep(100)
  }
}
/** GET /api/version on a new connection (a kept-alive one dies with its worker: the client retries that itself). */
const version = () => new Promise<{ revision: string }>((done, fail) => {
  get({ host: '127.0.0.1', port, path: '/api/version', agent: false }, res => { let text = ''; res.on('data', chunk => { text += chunk }); res.on('end', () => done(JSON.parse(text))) }).on('error', fail)
})

/** A release directory as setup.sh lays it out: <release>/dist/cli.js, with its own identity. */
function release(name: string) {
  const dir = join(root, name)
  execFileSync(process.execPath, [join(core, 'scripts/build.mjs'), '--cli', join(core, 'tests/fixtures/supervised.ts'), '--out', join(dir, 'dist')], { stdio: 'ignore' })
  writeFileSync(join(dir, 'dist/release.json'), JSON.stringify({ version: '0.0.1', revision: name }))
  return dir
}

/** An open stream of ticks, with the pid of the worker sending them. */
function ticker() {
  const ticks: Array<{ n: number, pid: number }> = []
  let response: IncomingMessage | null = null
  const request = get({ host: '127.0.0.1', port, path: '/api/ticker' }, res => {
    response = res
    let buffer = ''
    res.on('data', chunk => {
      buffer += chunk
      for (const match of buffer.matchAll(/event: tick\ndata: (.*)\n\n/g)) ticks.push(JSON.parse(match[1]!))
      buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2)
    })
  })
  request.on('error', () => {})
  return { ticks, ended: () => !!response?.complete || request.destroyed, close: () => request.destroy() }
}

let a: string, b: string
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'boardlab-handover-'))
  state = join(root, 'state'); mkdirSync(state)
  a = release('rev-a'); b = release('rev-b')
  port = await freePort()
  supervisor = spawn(process.execPath, ['--no-warnings', join(a, 'dist/cli.js'), 'serve', '--supervisor', '--port', String(port), '--state-dir', state, '--no-ui', '--modules', 'ticker'],
    { env: { ...process.env, BOARDLAB_WORKER_NODE_FLAGS: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  supervisor.stdout!.on('data', chunk => { log += chunk })
  supervisor.stderr!.on('data', chunk => { log += chunk })
  await until('the first worker', () => serving()?.revision === 'rev-a')
}, 120_000)

afterAll(async () => {
  const workers = execFileSync('ps', ['-o', 'pid=', '--ppid', String(supervisor.pid)], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean)
  supervisor.kill('SIGKILL')
  for (const pid of workers) { try { process.kill(pid, 'SIGKILL') } catch {} }
  rmSync(root, { recursive: true, force: true })
})

describe('the supervisor', () => {
  it('hands an update to the new release while the old worker keeps its open stream, and the old one exits once it ends', async () => {
    expect((await version()).revision).toBe('rev-a')
    const stream = ticker()
    await until('ticks', () => stream.ticks.length >= 3)
    const old = stream.ticks[0]!.pid
    writeFileSync(join(state, 'update.json'), JSON.stringify({ release: b, version: '0.0.1', revision: 'rev-b' }))
    process.kill(supervisor.pid!, 'SIGUSR2')
    await until('the new release serving', () => serving()?.revision === 'rev-b')
    // New connections reach the new release; the stream opened before keeps coming from the old worker.
    expect((await version()).revision).toBe('rev-b')
    const seen = stream.ticks.length
    await sleep(3_000)
    expect(stream.ticks.length).toBeGreaterThan(seen + 10)
    expect(stream.ended()).toBe(false)
    expect(stream.ticks.at(-1)!.pid).toBe(old)
    expect(alive(old)).toBe(true)
    stream.close()
    await until('the old worker to exit', () => !alive(old), 15_000)
    expect(log).toMatch(new RegExp(`boardd worker ${old} \\(first, rev-a\\) exited \\(code 0\\)`))
  }, 60_000)

  it('keeps the port open when the worker crashes: connections wait for the next worker instead of being refused', async () => {
    const crashed = serving()!.pid
    await version()
    await sleep(1_500)   // the worker reports its requests every second
    process.kill(crashed, 'SIGSEGV')
    // Asked at once and through the restart: every request is answered, by the next worker of the same release.
    const answers = await Promise.all([0, 50, 200, 500, 1000].map(async wait => { await sleep(wait); return (await version()).revision }))
    expect(answers).toEqual(['rev-b', 'rev-b', 'rev-b', 'rev-b', 'rev-b'])
    await until('the replacement', () => serving() && serving()!.pid !== crashed && serving())
    expect(log).toMatch(new RegExp(`boardd worker ${crashed} \\(update, rev-b\\) exited \\(SIGSEGV\\) after \\d+s; .*last requests: GET /api/version`))
  }, 60_000)
})
