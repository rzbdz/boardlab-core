/** Uploads by id, as a browser sends a file it cannot hash first: pieces, resuming, sealing by sha256, and the store's bound. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/core/db.ts'
import { PIECE } from '../src/core/files.ts'
import { BoardLab } from '../src/core/lab.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boardlab-uploads-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
async function* once(data: Buffer) { yield data }
function lab(now = { t: Date.parse('2026-01-01T00:00:00Z') }) {
  return { now, svc: new BoardLab({ db: openDatabase(join(dir, 'state.sqlite')), filesDir: join(dir, 'files'), now: () => now.t }) }
}

describe('uploads by id', () => {
  it('takes a file piece by piece, resumes from what arrived, and keeps it under the sha256 it hashes to', async () => {
    const { svc } = lab()
    const data = Buffer.from('a'.repeat(1000) + 'b'.repeat(500))
    const { id, piece } = svc.files.begin('../my image.zip', data.length)
    expect(piece).toBe(PIECE)
    expect(svc.files.status(id)).toEqual({ id, name: 'my_image.zip', size: data.length, received: 0 })
    expect(await svc.files.piece(id, 0, once(data.subarray(0, 1000)))).toEqual({ received: 1000, size: data.length })
    // A piece from anywhere but where it stopped is refused, and what arrived stays.
    await expect(svc.files.piece(id, 500, once(data.subarray(500)))).rejects.toThrow(/续传位置不对.*1000/)
    await expect(svc.files.seal('user:alice', id)).rejects.toThrow(/还没传完：1000 \/ 1500/)
    // More than the file's size is refused and cut back, so the retry starts clean.
    await expect(svc.files.piece(id, 1000, once(Buffer.concat([data.subarray(1000), Buffer.from('extra')])))).rejects.toThrow(/传多了/)
    expect(svc.files.status(id).received).toBe(1000)
    await svc.files.piece(id, 1000, once(data.subarray(1000)))
    const sealed = await svc.files.seal('user:alice', id)
    expect(sealed).toEqual({ sha256: sha(data), size: 1500, received: 1500, done: true, stored: true, name: 'my_image.zip' })
    expect(readFileSync(svc.files.get(sha(data))!.path)).toEqual(data)
    expect(() => svc.files.status(id)).toThrow(/没有这个上传/)
    // The same content again is not kept twice.
    const again = svc.files.begin('copy.zip', data.length)
    await svc.files.piece(again.id, 0, once(data))
    expect(await svc.files.seal('user:alice', again.id)).toMatchObject({ sha256: sha(data), stored: false })
    // A sha256 given to check against that does not match drops the upload.
    const wrong = svc.files.begin('w.zip', 3)
    await svc.files.piece(wrong.id, 0, once(Buffer.from('xyz')))
    await expect(svc.files.seal('user:alice', wrong.id, sha('other'))).rejects.toThrow(/对不上/)
    expect(() => svc.files.status(wrong.id)).toThrow(/没有这个上传/)
    expect(() => svc.files.begin('x', 0)).toThrow(/大小不对/)
    expect(() => svc.files.status('../../etc')).toThrow(/上传编号不对/)
  })
})

describe('uploads over HTTP', () => {
  it('takes raw pieces of at most 8 MiB, says where to resume, and seals', async () => {
    const { serve } = await import('../src/server/http.ts')
    const { BoardsClient } = await import('../src/shared/client.ts')
    const { svc } = lab()
    const socketPath = join(dir, 'boardd.sock')
    const running = await serve(svc, { port: 0, socketPath, uiDir: null })
    const put = (path: string, data: Buffer) => new Promise<{ status: number, body: string }>((resolve, reject) => {
      const req = request({ socketPath, path, method: 'PUT', headers: { 'content-length': data.length, 'x-boards-user': 'user:alice' } }, res => {
        let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject); req.end(data)
    })
    try {
      const client = new BoardsClient(socketPath)
      const data = Buffer.alloc(PIECE + 1234, 7)
      const { id } = await client.call<{ id: string, piece: number }>('POST', '/api/files/uploads', { name: 'pkg.zip', size: data.length })
      expect((await put(`/api/files/uploads/${id}?offset=0`, data.subarray(0, PIECE))).status).toBe(200)
      expect(await client.call('GET', `/api/files/uploads/${id}`)).toMatchObject({ received: PIECE })
      expect((await put(`/api/files/uploads/${id}?offset=0`, data.subarray(0, 10))).status).toBe(400)
      await put(`/api/files/uploads/${id}?offset=${PIECE}`, data.subarray(PIECE))
      expect(await client.call('POST', `/api/files/uploads/${id}/seal`, {})).toMatchObject({ sha256: sha(data), size: data.length, stored: true })
      // Uploading by sha256 stays closed.
      expect((await put(`/api/files/${sha(data)}`, Buffer.from('x'))).status).toBe(403)
      // A piece too large is refused.
      const big = await client.call<{ id: string }>('POST', '/api/files/uploads', { name: 'big.zip', size: PIECE * 2 })
      expect((await put(`/api/files/uploads/${big.id}?offset=0`, Buffer.alloc(PIECE + 1))).status).toBe(400)
      await client.call('POST', `/api/files/uploads/${big.id}/abandon`, {})
      await expect(client.call('GET', `/api/files/uploads/${big.id}`)).rejects.toMatchObject({ status: 404 })
    } finally { await running.close() }
  })
})
