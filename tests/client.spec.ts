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
