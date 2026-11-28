/**
 * Cancelling what boardd does to a board or a lab: one way (`POST /api/cancel`, the kernel's `cancel`) for every kind
 * of operation a backend says it can stop, the board busy until the run has ended, and the run answering cancelled.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/core/db.ts'
import { BoardLab } from '../src/core/lab.ts'
import { BoardError, CancelledError } from '../src/core/errors.ts'
import type { Backend, BoardTarget, BootFile, LabConfig } from '../src/core/backend.ts'
import { serve } from '../src/server/http.ts'
import { main } from '../bare/boardlab.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boardlab-cancel-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A backend whose boot runs until its signal aborts, and which then ends the way a backend's job does. */
class Waiting implements Backend {
  kind = '测试'
  cancels: Backend['cancels'] = ['boot', 'reset']
  cancel?: Backend['cancel']
  boots: Array<{ signal: AbortSignal | undefined }> = []
  resets = 0
  relay: Backend['relay'] = {
    reset: (_config, _target, _notice, signal) => new Promise((resolve, reject) => {
      this.resets++
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
    enterDownload: async () => {},
  }
  serial: Backend['serial'] = { open: async () => { throw new Error('no console') } }
  download: Backend['download'] = {
    stage: async () => 'OKAY', present: async () => true,
    boot: (_config: LabConfig, _target: BoardTarget, _files: BootFile[], _timing, signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
      this.boots.push({ signal })
      // The backend's job ends a little after it was told to, as a job does at its next step.
      signal?.addEventListener('abort', () => setTimeout(() => reject(new Error('job ended: cancelled')), 20), { once: true })
    }),
  }
}

function lab(backend: Backend) {
  const svc = new BoardLab({
    db: openDatabase(join(dir, 'lab.sqlite')), sleep: async () => {}, firmwareDir: join(dir, 'firmware'), filesDir: join(dir, 'files'),
    modules: [{ id: 'test-here', title: '测试', setup: core => core.backends.register('local', backend, { configurable: false, isDefault: true }) }],
  })
  svc.boards.add('user:alice', { name: 'b1', slot: 1, chips: [{ serialPath: '/dev/ttyUSB1', alias: 'b1', downloadUsbPath: '3-2.3' }] })
  return svc
}
const call = (svc: BoardLab, path: string, holder: string, body: Record<string, unknown>) =>
  Promise.resolve().then(() => svc.api.match('POST', path)!.endpoint.handle({ body, query: new URLSearchParams(), params: {}, caller: { holder, local: true }, signal: new AbortController().signal, upload: null }))
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

describe('cancelling an operation', () => {
  it('stops a boot that runs until aborted: the board stays busy until it ended, and the boot answers cancelled', async () => {
    const backend = new Waiting()
    const svc = lab(backend)
    const { token } = await svc.locks.lock('b1', 'claude:s1', '启动')
    const booting = call(svc, '/api/boot', 'claude:s1', { board: 'b1', token, files: ['https://images.test/Image.itb'] })
    // `backendFiles` is not set: a URL is refused, so give the backend files it can take.
    await booting.catch(() => {})
    backend.download.backendFiles = true
    const running = call(svc, '/api/boot', 'claude:s1', { board: 'b1', token, files: ['https://images.test/Image.itb'] })
    const outcome = running.then(() => 'done', error => error)
    await tick()
    expect(svc.boards.get('b1').busy).toMatchObject({ kind: 'boot', cancellable: true })
    expect(backend.boots[0]!.signal?.aborted).toBe(false)

    // Someone without the lock cannot stop it; its holder can, by board name.
    await expect(call(svc, '/api/cancel', 'claude:other', { target: 'b1' })).rejects.toThrow(/正被 claude:s1 使用/)
    expect(await call(svc, '/api/cancel', 'claude:s1', { target: 'b1', token })).toMatchObject({ cancelled: true, message: expect.stringContaining('停下') })
    expect(backend.boots[0]!.signal?.aborted).toBe(true)
    // Until the backend's job has ended the board is still busy: nothing else starts on it halfway through.
    expect(svc.boards.get('b1').busy).toMatchObject({ kind: 'boot' })
    const error = await outcome
    expect(error).toBeInstanceOf(CancelledError)
    expect((error as CancelledError).code).toBe('cancelled')
    expect((error as Error).message).toMatch(/^已取消/)
    expect(svc.boards.get('b1').busy).toBeNull()
    // The action log says it was cancelled, not that the hardware failed.
    const actions = svc.boards.detail('b1').actions
    expect(actions.find(action => action.kind === 'boot')).toMatchObject({ ok: false, message: expect.stringMatching(/^已取消/) })
    expect(actions.find(action => action.kind === 'cancel')).toMatchObject({ actor: 'claude:s1', ok: true })
  })

  it('cancels any kind the backend stops (a reset waiting for a person), and refuses what it cannot stop', async () => {
    const backend = new Waiting()
    const svc = lab(backend)
    const { token } = await svc.locks.lock('b1', 'claude:s1', '复位')
    const resetting = call(svc, '/api/reset', 'claude:s1', { board: 'b1', token }).then(() => 'done', error => error)
    await tick()
    expect(svc.boards.get('b1').busy).toMatchObject({ kind: 'reset', cancellable: true })
    // The older endpoint is the same cancel.
    expect(await call(svc, '/api/board/cancel', 'claude:s1', { board: 'b1', token })).toMatchObject({ cancelled: true })
    expect(await resetting).toBeInstanceOf(CancelledError)
    expect(svc.boards.get('b1').busy).toBeNull()

    // An operation its backend does not list stops only when it ends: the board says so, and a cancel is refused.
    backend.cancels = []
    const again = call(svc, '/api/reset', 'claude:s1', { board: 'b1', token }).catch(error => error)
    await tick()
    expect(svc.boards.get('b1').busy).toMatchObject({ kind: 'reset', cancellable: false })
    await expect(call(svc, '/api/cancel', 'claude:s1', { target: 'b1', token })).rejects.toThrow(/不能中途取消/)
    svc.locks.unlock('b1', { holder: 'claude:s1', token })
    await again
    // Nothing running: nothing to cancel.
    await expect(call(svc, '/api/cancel', 'user:alice', { target: 'b1' })).rejects.toThrow(/不用取消/)
  })

  it("passes on a backend's own answer that nothing runs, and names a refusal as one", async () => {
    const backend = new Waiting()
    const svc = lab(backend)
    const { token } = await svc.locks.lock('b1', 'claude:s1', '刷机')
    backend.cancel = async () => { throw new BoardError('conflict', 'b1：主机上没有在跑的任务；上一个 j-1（flash）failed') }
    const nothing = await call(svc, '/api/cancel', 'claude:s1', { target: 'b1', token }).catch(error => error)
    expect(nothing).toBeInstanceOf(BoardError)
    expect(nothing).toMatchObject({ code: 'conflict', message: expect.stringMatching(/上一个 j-1/) })
    backend.cancel = async () => { throw new Error('host unreachable') }
    await expect(call(svc, '/api/cancel', 'claude:s1', { target: 'b1', token })).rejects.toMatchObject({ code: 'hardware', message: expect.stringMatching(/没有停下：host unreachable/) })
  })

  it('stops a file-by-file boot between files, even on a backend that lists nothing', async () => {
    const staged: string[] = []
    let release!: () => void
    const backend: Backend = {
      kind: '测试', relay: { reset: async () => {}, enterDownload: async () => {} }, serial: { open: async () => { throw new Error('none') } },
      download: {
        stage: async (_config, _target, file) => { staged.push(file.path); if (staged.length === 1) await new Promise<void>(resolve => { release = resolve }); return 'OKAY' },
        present: async () => true,
      },
    }
    const svc = lab(backend)
    const { token } = await svc.locks.lock('b1', 'claude:s1', '启动')
    const files = ['/etc/hostname', '/etc/hosts']
    const booting = call(svc, '/api/boot', 'claude:s1', { board: 'b1', token, files }).then(() => 'done', error => error)
    await tick()
    expect(svc.boards.get('b1').busy).toMatchObject({ cancellable: true })
    await call(svc, '/api/cancel', 'claude:s1', { target: 'b1', token })
    release()
    expect(await booting).toBeInstanceOf(CancelledError)
    expect(staged).toEqual(['/etc/hostname'])
  })

  it('is `boardlab cancel <board>` on the command line, with the token the CLI holds', async () => {
    const backend = new Waiting()
    backend.download.backendFiles = true
    const svc = lab(backend)
    const running = await serve(svc, { port: 44000 + Math.floor(Math.random() * 1000), socketPath: join(dir, 'boardd.sock'), uiDir: null })
    const said: string[] = []
    const quiet = { log: console.log, error: console.error }
    console.log = (...args: unknown[]) => { said.push(args.join(' ')) }; console.error = () => {}
    try {
      await main(['lock', 'b1', '--for', '启动', '--state-dir', dir, '--as', 'claude:cli'])
      const token = JSON.parse(readFileSync(join(dir, 'cli-tokens.json'), 'utf8'))
      expect(JSON.stringify(token)).toContain('b1')
      const booting = main(['boot', 'b1', 'https://images.test/Image.itb', '--state-dir', dir, '--as', 'claude:cli']).then(() => 'done', error => error)
      while (!svc.boards.get('b1').busy) await tick()
      await main(['cancel', 'b1', '--state-dir', dir, '--as', 'claude:cli'])
      expect(said.at(-1)).toMatch(/停下/)
      const failed = await booting
      // The client sees the operation's code: the CLI exits 4 for it, as boardctrl does.
      expect(failed).toMatchObject({ code: 'cancelled', message: expect.stringMatching(/^已取消/) })
    } finally { Object.assign(console, quiet); await running.close() }
  })

  it('keeps the backend lease while a run outlives its lock, and says when the backend refused to stop it', async () => {
    const leases: string[] = []
    let refuse: string | null = null
    let finish!: () => void
    const backend: Backend = {
      kind: '测试', relay: { reset: async () => {}, enterDownload: async () => {} }, serial: { open: async () => { throw new Error('none') } },
      download: { stage: async () => 'OKAY', present: async () => true },
      cancels: ['flash'],
      lease: { take: async () => { leases.push('take'); return 'L1' }, give: async (_config, _device, token) => { leases.push(`give ${token}`) } },
      builds: {
        boot: async () => '',
        flash: (_config, target, _pkg, _progress, signal) => new Promise<string>((resolve, reject) => {
          finish = () => resolve('written')
          signal?.addEventListener('abort', () => {
            // The backend asks its own side to stop, under the lease the run holds, and hands the answer over.
            const asked = refuse ? Promise.reject(new Error(refuse)) : Promise.resolve()
            ;(signal.reason as CancelledError).answer?.(asked)
            if (!refuse && target.lease === 'L1') setTimeout(() => reject(new Error('stopped')), 5)
          }, { once: true })
        }),
      },
    }
    const svc = lab(backend)
    const flash = async () => {
      const { token } = await svc.locks.lock('b1', 'claude:s1', '刷机')
      const running = call(svc, '/api/flash/package', 'claude:s1', { board: 'b1', token, url: 'https://images.test/pkg.zip' }).then(out => out, error => error)
      await tick()
      svc.locks.unlock('b1', { holder: 'claude:s1', token })
      await svc.locks.settle('b1')
      return { running }
    }
    // Unlocked while it runs: the lease stays with the run, and anyone's cancel stops it under that lease.
    const { running: first } = await flash()
    // Taken for the lock, then again once the lock was let go while the run kept the lease.
    expect(leases).toEqual(['take', 'take', 'take'])
    expect(await call(svc, '/api/cancel', 'user:bob', { target: 'b1' })).toMatchObject({ cancelled: true })
    expect(await first).toBeInstanceOf(CancelledError)
    await svc.locks.settle('b1')
    expect(leases.at(-1)).toBe('give L1')
    // A backend that will not stop says why, and the run goes on to its end.
    refuse = 'the host is past the point where it can stop'
    const { running: second } = await flash()
    await expect(call(svc, '/api/cancel', 'user:bob', { target: 'b1' })).rejects.toMatchObject({ code: 'hardware', message: expect.stringContaining('past the point') })
    expect(svc.boards.get('b1').busy).toMatchObject({ kind: 'boot' })
    finish()
    expect(await second).toMatchObject({ output: 'written' })
    // The run ended with the board free, so the lab's lease is given back where it used to be kept for the next lock.
    await svc.locks.settle('b1')
    expect(leases.at(-1)).toBe('give L1')
  })

  it('cancels a run on a lab by `lab:<id>`', async () => {
    const svc = lab(new Waiting())
    let seen: AbortSignal | null = null
    const running = svc.kernel.doing(['lab:x'], 'install', '安装中', 'user:alice', (_line, signal) => new Promise((_resolve, reject) => {
      seen = signal
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
    }), { cancellable: true }).catch(error => error)
    await tick()
    expect(await call(svc, '/api/cancel', 'user:alice', { target: 'lab:x' })).toMatchObject({ cancelled: true })
    expect(seen!.aborted).toBe(true)
    expect(await running).toBeInstanceOf(CancelledError)
    await expect(call(svc, '/api/cancel', 'user:alice', { target: 'lab:x' })).rejects.toThrow(/不用取消/)
  })
})
