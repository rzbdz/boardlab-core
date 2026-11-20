import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BoardsClient } from '../src/shared/client.ts'

describe('the client while boardd is away', () => {
  it('tries a read again until boardd is back, and never a write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boardlab-client-'))
    const socket = join(dir, 'boardd.sock')
    const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}') })
    try {
      const client = new BoardsClient(socket)
      // Nothing listens yet: a write fails at once, a read waits for boardd.
      await expect(client.call('POST', '/api/reset', {})).rejects.toMatchObject({ code: 'unavailable' })
      const read = client.call('GET', '/api/state')
      setTimeout(() => server.listen(socket), 600)
      await expect(read).resolves.toEqual({ ok: true })
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('fails a read at once when its caller asks for no waits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boardlab-client-'))
    try {
      const client = new BoardsClient(join(dir, 'boardd.sock'))
      client.retryMs = []
      const started = Date.now()
      await expect(client.call('GET', '/api/state')).rejects.toMatchObject({ code: 'unavailable' })
      expect(Date.now() - started).toBeLessThan(150)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('a run whose connection drops', () => {
  it('follows the run by the id it chose until it ends, and never sends the request again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boardlab-client-'))
    const socket = join(dir, 'boardd.sock')
    const posts: string[] = [], reads: string[] = []
    let status = 'running'
    const server = createServer((request, response) => {
      if (request.method === 'POST') {
        posts.push(String(request.headers['x-boards-run']))
        // The worker died mid-flash: the connection drops with no answer.
        request.resume(); return void request.socket.destroy()
      }
      reads.push(request.url!)
      const id = new URL(request.url!, 'http://x').searchParams.get('id')
      if (id !== posts[0]) { response.writeHead(404, { 'Content-Type': 'application/json' }); return void response.end('{"error":"没有这次运行","code":"not-found"}') }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id, status, message: status === 'succeeded' ? 'written' : status === 'cancelled' ? '已取消：b1' : null }))
    })
    await new Promise<void>(resolve => server.listen(socket, resolve))
    try {
      const client = new BoardsClient(socket)
      client.followMs = 10
      const told: string[] = []
      client.onReconnect = id => told.push(id)
      const flashing = client.flashPackage('b1', { url: 'https://images.test/pkg.zip' })
      setTimeout(() => { status = 'succeeded' }, 60)
      await expect(flashing).resolves.toEqual({ output: 'written' })
      expect(posts).toHaveLength(1)
      expect(posts[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
      expect(told).toEqual(posts)
      expect(reads.every(url => url === `/api/run?id=${posts[0]}`)).toBe(true)

      // A run that ended otherwise fails with its own outcome; a cancelled one as cancelled.
      status = 'cancelled'; posts.length = 0
      await expect(client.flashPackage('b1', { url: 'https://images.test/pkg.zip' })).rejects.toMatchObject({ code: 'cancelled', message: '已取消：b1' })
      status = 'interrupted'; posts.length = 0
      await expect(client.bootSdk('b1', { sdk: 'x' })).rejects.toMatchObject({ code: 'interrupted' })
      // Each run has its own id.
      expect(told[1]).not.toBe(told[2])
      // A chosen id is used once.
      client.nextRun = 'chosen-run-id-1'; posts.length = 0; status = 'succeeded'
      await client.boot('b1', ['Image'])
      expect(posts).toEqual(['chosen-run-id-1'])
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('gives the dropped connection back when boardd never started the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boardlab-client-'))
    const socket = join(dir, 'boardd.sock')
    const server = createServer((request, response) => {
      if (request.method === 'POST') { request.resume(); return void request.socket.destroy() }
      response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{"error":"没有这次运行","code":"not-found"}')
    })
    await new Promise<void>(resolve => server.listen(socket, resolve))
    try {
      const client = new BoardsClient(socket)
      await expect(client.flashPackage('b1', { url: 'https://images.test/pkg.zip' })).rejects.toThrow(/socket hang up|ECONNRESET/)
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
