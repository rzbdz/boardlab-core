/** Watched consoles: a backend that cannot open them is not asked again in a tight loop, and viewers are told why. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/core/db.ts'
import { BoardLab } from '../src/core/lab.ts'
import type { Backend } from '../src/core/backend.ts'
import type { ConsoleSession } from '../src/core/console.ts'
import { serve } from '../src/server/http.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boardlab-consoles-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** A backend whose console opens only when `working`, and whose open sessions can be closed by the test. */
class Flaky implements Backend {
  kind = 'flaky'
  working = false
  opens = 0
  closers: Array<(reason: string) => void> = []
  relay: Backend['relay'] = { reset: async () => {}, enterDownload: async () => {} }
  download: Backend['download'] = { stage: async () => '', present: async () => false }
  serial: Backend['serial'] = {
    open: async () => {
      this.opens++
      if (!this.working) throw new Error('serial adapter unplugged')
      const closes: Array<(reason: string) => void> = []
      this.closers.push(reason => closes.forEach(fn => fn(reason)))
      const session: ConsoleSession = {
        hello: { alias: 'b', device: null, baud: 115200, transport: 'test' }, history: ['boot'],
        send: () => {}, onOutput: () => () => {}, onClose: fn => { closes.push(fn) }, close: () => {},
      }
      return session
    },
  }
}

function lab(now: () => number) {
  const backend = new Flaky()
  const svc = new BoardLab({
    db: openDatabase(join(dir, 'lab.sqlite')), now, sleep: async () => {},
    consoleTiming: { openRetryMs: 1_000, openRetryMaxMs: 8_000 },
    modules: [{ id: 'flaky', title: 'flaky', setup: core => core.backends.register('local', backend, { configurable: false, isDefault: true }) }],
  })
  svc.boards.add('user:alice', { name: 'b', slot: 1, chips: [{ serialPath: '/dev/ttyUSB1', alias: 'b' }] })
  return { svc, backend }
}

describe('watched consoles', () => {
  it('back off opening a console whose backend fails, telling every viewer the last error meanwhile', async () => {
    let clock = 1_000_000
    const { svc, backend } = lab(() => clock)
    await expect(svc.consoles.open('b')).rejects.toThrow('serial adapter unplugged')
    expect(backend.opens).toBe(1)
    // Viewers retrying at once all get the error without another backend open.
    for (let i = 0; i < 5; i++) await expect(svc.consoles.open('b')).rejects.toThrow(/serial adapter unplugged（1 秒后再试）/)
    expect(backend.opens).toBe(1)
    expect(svc.consoles.reap().failing).toEqual([{ console: 'b.die0', error: 'serial adapter unplugged', failures: 1, retryInMs: 1_000 }])
    clock += 1_000
    await expect(svc.consoles.open('b')).rejects.toThrow('serial adapter unplugged')
    expect(backend.opens).toBe(2)
    // Each failure doubles the wait, up to the cap.
    clock += 1_999
    await expect(svc.consoles.open('b')).rejects.toThrow(/后再试/)
    expect(backend.opens).toBe(2)
    clock += 1
    backend.working = true
    const session = await svc.consoles.open('b')
    expect(backend.opens).toBe(3)
    expect(session.history).toEqual(['boot'])
    session.close()
  })

  it('count a session that closes right after it opened as a failed open', async () => {
    let clock = 1_000_000
    const { svc, backend } = lab(() => clock)
    backend.working = true
    const session = await svc.consoles.open('b')
    const reasons: string[] = []
    session.onClose(reason => reasons.push(reason))
    backend.closers[0]!('pipe ended')
    expect(reasons).toEqual(['pipe ended'])
    await expect(svc.consoles.open('b')).rejects.toThrow(/pipe ended（1 秒后再试）/)
    expect(backend.opens).toBe(1)
    clock += 1_000
    await svc.consoles.open('b')
    expect(backend.opens).toBe(2)
  })

  it('tell an event-stream viewer why the console did not open, and every viewer when boardd stops', async () => {
    const { svc, backend } = lab(Date.now)
    const port = 44000 + Math.floor(Math.random() * 1000)
    const running = await serve(svc, { port, socketPath: join(dir, 'c.sock'), uiDir: null })
    try {
      const failed = await fetch(`http://127.0.0.1:${port}/api/console?board=b`, { headers: { Accept: 'text/event-stream' } })
      expect(failed.status).toBe(200)
      // Unbuffered through a proxy: a buffered stream would hold back the pings that show it is alive.
      expect(failed.headers.get('x-accel-buffering')).toBe('no')
      expect(failed.headers.get('cache-control')).toMatch(/no-cache/)
      expect(failed.headers.get('cache-control')).toMatch(/no-transform/)
      expect(await failed.text()).toContain('event: closed\ndata: "serial adapter unplugged"')
      // A plain request still gets an error reply.
      expect((await fetch(`http://127.0.0.1:${port}/api/console?board=b`)).status).toBe(502)

      await new Promise(resolve => setTimeout(resolve, 1_100))
      backend.working = true
      const live = await fetch(`http://127.0.0.1:${port}/api/console?board=b`, { headers: { Accept: 'text/event-stream' } })
      const reader = live.body!.getReader()
      let text = ''
      while (!text.includes('event: history')) text += new TextDecoder().decode((await reader.read()).value)
      expect(text).toContain(`event: hello\ndata: ${JSON.stringify({ boot: svc.kernel.boot })}`)
      svc.consoles.shutdown('服务重启')
      for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value) }
      expect(text).toContain('event: restart\ndata: {"reason":"服务重启"}')
    } finally { await running.close() }
  })
})
