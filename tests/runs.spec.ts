/**
 * Runs kept from start to end: each one's outcome recorded under its id (the client's when it chose a valid one), the
 * board showing its last one, and a boardd that starts after another died following the runs it left again, or
 * marking them interrupted when their backend cannot be followed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/core/db.ts'
import { BoardLab } from '../src/core/lab.ts'
import type { Backend } from '../src/core/backend.ts'
import { resumeRuns } from '../src/core/resume.ts'
import { withRunId } from '../src/core/runs.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boardlab-runs-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A backend whose flash reports a handle and ends when the test says; `follow` (when given) follows that handle. */
function backend(follow?: Backend['follow']) {
  const flashes: Array<{ ok: () => void, fail: (message: string) => void }> = []
  const fake: Backend = {
    kind: '测试', relay: { reset: async () => {}, enterDownload: async () => {} }, serial: { open: async () => { throw new Error('none') } },
    download: { stage: async () => 'OKAY', present: async () => true },
    builds: {
      boot: async () => '',
      flash: (_config, _target, _pkg, progress, _signal, report) => new Promise<string>((resolve, reject) => {
        report?.handle('job-7')
        progress('writing 10%')
        flashes.push({ ok: () => resolve('written'), fail: message => reject(new Error(message)) })
      }),
    },
    ...(follow ? { follow } : {}),
  }
  return { fake, flashes }
}

function lab(fake: Backend, add = true) {
  const svc = new BoardLab({
    db: openDatabase(join(dir, 'lab.sqlite')), sleep: async () => {}, firmwareDir: join(dir, 'firmware'), filesDir: join(dir, 'files'),
    modules: [{ id: 'test-here', title: '测试', setup: core => core.backends.register('local', fake, { configurable: false, isDefault: true }) }],
  })
  if (add) svc.boards.add('user:alice', { name: 'b1', slot: 1, chips: [{ serialPath: '/dev/ttyUSB1', alias: 'b1', downloadUsbPath: '3-2.3' }] })
  return svc
}
const call = (svc: BoardLab, method: 'GET' | 'POST', path: string, holder: string, body: Record<string, unknown>, query = '') =>
  Promise.resolve().then(() => svc.api.match(method, path)!.endpoint.handle({ body, query: new URLSearchParams(query), params: {}, caller: { holder, local: true }, signal: new AbortController().signal, upload: null }))
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
const flash = async (svc: BoardLab, id?: string) => {
  const { token } = await svc.locks.lock('b1', 'claude:s1', '刷机')
  const running = withRunId(id, () => call(svc, 'POST', '/api/flash/package', 'claude:s1', { board: 'b1', token, url: 'https://images.test/pkg.zip' })).then(out => out, error => error)
  await tick()
  return { running, token }
}

describe('runs', () => {
  it('records a run under the id its client chose, its outcome kept on the board after it ended', async () => {
    const { fake, flashes } = backend()
    const svc = lab(fake)
    const { running } = await flash(svc, 'client-run-0001')
    expect(svc.boards.get('b1').busy).toMatchObject({ id: 'client-run-0001', kind: 'boot' })
    expect(svc.boards.get('b1').run).toMatchObject({ id: 'client-run-0001', status: 'running', boards: ['b1'], by: 'claude:s1' })
    expect(svc.kernel.runs.get('client-run-0001')).toMatchObject({ handle: 'job-7' })
    flashes[0]!.ok()
    expect(await running).toEqual({ output: 'written' })
    expect(svc.boards.get('b1').busy).toBeNull()
    expect(svc.boards.get('b1').run).toMatchObject({ id: 'client-run-0001', status: 'succeeded', message: 'written', endedAt: expect.any(String) })
    // A client that lost its connection reads it by its id; what boardd needs to follow it again stays inside.
    const read = await call(svc, 'GET', '/api/run', 'claude:s1', {}, 'id=client-run-0001') as Record<string, unknown>
    expect(read).toMatchObject({ status: 'succeeded', line: 'writing 10%' })
    expect(read).not.toHaveProperty('handle')
    await expect(call(svc, 'GET', '/api/run', 'claude:s1', {}, 'id=nothing-like-it')).rejects.toThrow(/没有这次运行/)
  })

  it('refuses an id already used, makes its own for an invalid one, and records a failure', async () => {
    const { fake, flashes } = backend()
    const svc = lab(fake)
    const first = await flash(svc, 'client-run-0002')
    flashes[0]!.ok(); await first.running
    // Reusing the id is refused, never joined to the run that had it.
    const again = await flash(svc, 'client-run-0002')
    expect(await again.running).toMatchObject({ code: 'conflict' })
    expect(svc.boards.get('b1').busy).toBeNull()
    // An id that is not a valid one is replaced by one boardd makes.
    const bad = await flash(svc, 'no')
    const id = svc.boards.get('b1').busy!.id!
    expect(id).not.toBe('no')
    flashes[1]!.fail('the flasher broke')
    expect(await bad.running).toBeInstanceOf(Error)
    expect(svc.kernel.runs.get(id)).toMatchObject({ status: 'failed', message: expect.stringContaining('the flasher broke') })
  })

  it('marks a run a dead boardd left interrupted when its backend cannot follow it; the board takes a new run', async () => {
    const old = backend()
    const before = lab(old.fake)
    const { token } = await flash(before, 'client-run-0003')
    // That boardd died mid-flash; the next one starts on the same database.
    const next = backend()
    const after = lab(next.fake, false)
    expect(resumeRuns(after, () => false)).toEqual({ followed: [], interrupted: ['client-run-0003'] })
    expect(after.boards.get('b1').run).toMatchObject({ id: 'client-run-0003', status: 'interrupted', message: expect.stringContaining('重启') })
    expect(after.boards.get('b1').busy).toBeNull()
    // Kept as the board's last run, it never blocks the next one (the lock, kept in the database, is still the holder's).
    const running = call(after, 'POST', '/api/flash/package', 'claude:s1', { board: 'b1', token, url: 'https://images.test/pkg.zip' })
    await tick()
    next.flashes[0]!.ok()
    expect(await running).toEqual({ output: 'written' })
    expect(after.boards.get('b1').run).toMatchObject({ status: 'succeeded' })
    expect(after.boards.get('b1').run!.id).not.toBe('client-run-0003')
  })

  it('follows a run a dead boardd left again by its handle, under the same id, to its real outcome', async () => {
    const old = backend()
    const before = lab(old.fake)
    await flash(before, 'client-run-0004')
    let end!: (output: string) => void
    const followed: string[] = []
    const next = backend((_config, _target, handle, progress) => new Promise<string>(resolve => {
      followed.push(handle); progress('writing 80%'); end = resolve
    }))
    const after = lab(next.fake, false)
    // A run whose process is still alive (a worker being replaced) is left to it.
    expect(resumeRuns(after, () => true)).toEqual({ followed: [], interrupted: [] })
    expect(resumeRuns(after, () => false)).toEqual({ followed: ['client-run-0004'], interrupted: [] })
    await tick()
    expect(followed).toEqual(['job-7'])
    expect(after.boards.get('b1').busy).toMatchObject({ id: 'client-run-0004', label: '刷机中', by: 'claude:s1', line: 'writing 80%' })
    // Taken over once: a second pass leaves it alone.
    expect(resumeRuns(after, () => false)).toEqual({ followed: [], interrupted: [] })
    end('written after all')
    await tick()
    expect(after.boards.get('b1').busy).toBeNull()
    expect(after.kernel.runs.get('client-run-0004')).toMatchObject({ status: 'succeeded', message: 'written after all' })
    expect(after.boards.detail('b1').actions[0]).toMatchObject({ kind: 'boot', ok: true })
  })
})
