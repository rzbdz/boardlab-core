/** Uploads by id, as a browser sends a file it cannot hash first: pieces, resuming, sealing by sha256, and the store's bound. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs'
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
    // A file bigger than the store could keep is refused before anything is sent.
    svc.kernel.setSetting('files.maxBytes', '100')
    expect(() => svc.files.begin('big.zip', 101)).toThrow(/文件太大/)
    svc.kernel.setSetting('files.maxBytes', '')
    expect(() => svc.files.status('../../etc')).toThrow(/上传编号不对/)
  })

  it('writes one piece of an upload at a time: a piece sent again while the first is written is refused, and nothing is doubled', async () => {
    const { svc } = lab()
    const data = Buffer.from('0123456789'.repeat(20))
    const { id } = svc.files.begin('p.bin', data.length)
    let let_go!: () => void
    const gate = new Promise<void>(resolve => { let_go = resolve })
    async function* slow() { yield data.subarray(0, 50); await gate; yield data.subarray(50, 100) }
    const first = svc.files.piece(id, 0, slow())
    await new Promise(resolve => setTimeout(resolve, 20))
    // The same piece again, as a browser sends it when a proxy gave up on the first.
    await expect(svc.files.piece(id, 0, once(data.subarray(0, 100)))).rejects.toMatchObject({ code: 'conflict' })
    await expect(svc.files.seal('user:alice', id)).rejects.toMatchObject({ code: 'conflict' })
    let_go()
    expect(await first).toEqual({ received: 100, size: data.length })
    expect(svc.files.status(id).received).toBe(100)
    await svc.files.piece(id, 100, once(data.subarray(100)))
    expect((await svc.files.seal('user:alice', id)).sha256).toBe(sha(data))
  })

  it('says how much the store holds, forgets an upload nobody finished, and keeps under its bound by removing what was used longest ago', async () => {
    // The files' own times are the machine's: the clock starts there too.
    const { now, svc } = lab({ t: Date.now() })
    const keep = async (text: string) => { const up = svc.files.begin(`${text}.bin`, text.length * 100); await svc.files.piece(up.id, 0, once(Buffer.from(text.repeat(100)))); return (await svc.files.seal('user:alice', up.id)).sha256 }
    const old = await keep('old'), mid = await keep('mid')
    const left = svc.files.begin('left.bin', 10)
    await svc.files.piece(left.id, 0, once(Buffer.from('12345')))
    // Two kept files of 300 bytes, and an unfinished upload: its 5 bytes and the small note of its name and size.
    const usage = svc.files.usage()
    expect(usage).toMatchObject({ files: 2, max: 20 * 2 ** 30, keepDays: 3 })
    expect(usage.pending).toBeGreaterThanOrEqual(5)
    expect(usage.used).toBe(600 + usage.pending)
    expect(typeof svc.files.usage().free).toBe('number')

    // Past the bound, the files used longest ago go first, as many as it takes; nothing used in the last hour goes.
    svc.files.abandon(left.id)
    const used = (hex: string, hoursAgo: number) => { const at = new Date(now.t - hoursAgo * 3_600_000); for (const path of [join(dir, 'files', hex), svc.files.get(hex)!.path]) utimesSync(path, at, at) }
    used(old, 3); used(mid, 2)
    svc.kernel.setSetting('files.maxBytes', '700')
    const fresh = await keep('new')
    expect(existsSync(join(dir, 'files', old))).toBe(false)
    expect(existsSync(join(dir, 'files', mid))).toBe(true)
    expect(existsSync(join(dir, 'files', fresh))).toBe(true)
    // Under a bound it cannot meet without removing a file used within the hour, that file stays.
    svc.kernel.setSetting('files.maxBytes', '350')
    used(mid, 0)
    await keep('one')
    expect(existsSync(join(dir, 'files', mid))).toBe(true)
    // A file a flash is reading stays however long ago it was used, until the flash lets it go.
    const release = svc.files.hold(svc.files.get(fresh)!.path)
    used(fresh, 5)
    await keep('two')
    expect(existsSync(join(dir, 'files', fresh))).toBe(true)
    release()
    await keep('six')
    expect(existsSync(join(dir, 'files', fresh))).toBe(false)

    // An upload left for more than three days is removed with the rest of the old files.
    const stale = svc.files.begin('stale.bin', 10)
    now.t += 4 * 86_400_000
    svc.files.begin('later.bin', 1)
    expect(() => svc.files.status(stale.id)).toThrow(/没有这个上传/)
    expect(readdirSync(join(dir, 'files', '.uploads'))).toHaveLength(1)
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
      expect(await client.call('GET', '/api/files/usage')).toMatchObject({ used: data.length, files: 1, pending: 0 })
      // Uploading by sha256 stays closed.
      expect((await put(`/api/files/${sha(data)}`, Buffer.from('x'))).status).toBe(403)
      // A piece too large is refused.
      const big = await client.call<{ id: string }>('POST', '/api/files/uploads', { name: 'big.zip', size: PIECE * 2 })
      expect((await put(`/api/files/uploads/${big.id}?offset=0`, Buffer.alloc(PIECE + 1))).status).toBe(400)
      await client.call('POST', `/api/files/uploads/${big.id}/abandon`, {})
      expect((await client.call<{ pending: number }>('GET', '/api/files/usage')).pending).toBe(0)
    } finally { await running.close() }
  })
})
