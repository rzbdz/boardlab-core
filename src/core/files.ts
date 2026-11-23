/**
 * Files remote CLIs and the page send to boardd (boot images, flash packages, files for SDK work), kept under their
 * sha256: the content is checked against it as it arrives, a file already here is not stored twice, and files unused for
 * three days are removed.
 */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename, join } from 'node:path'
import { BoardError } from './errors.ts'
import type { Kernel } from './kernel.ts'

const KEEP_MS = 3 * 86_400_000
export const SHA256 = /^[0-9a-f]{64}$/
/** The most one upload request carries (see `Files.put`): small enough that Node on RISC-V never crashed on it. */
export const PIECE = 8 * 1024 * 1024

/** A file being uploaded: where the last piece left it, and whether the whole file is in. */
export interface Uploaded { sha256: string, size: number, received: number, done: boolean, stored: boolean }

/** Above this, hash with `sha256sum`: Node's V8 on some RISC-V builds crashes while streaming a large file. */
const HASH_IN_NODE_MAX = 8 * 1024 * 1024

/** The sha256 of a file, without putting its bytes through V8 when it is large. */
export async function sha256File(path: string): Promise<string> {
  if (statSync(path).size <= HASH_IN_NODE_MAX) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  }
  return await new Promise((resolve, reject) => {
    const child = spawn('sha256sum', ['--', path], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    // Never fall back to streaming a large file through V8: that is the crash this avoids.
    child.on('error', error => reject(new Error(`找不到 sha256sum，无法安全校验大文件 ${path}：${error.message}`)))
    child.on('exit', code => {
      const hash = out.trim().split(/\s+/)[0]
      if (code === 0 && hash && /^[0-9a-f]{64}$/.test(hash)) resolve(hash)
      else reject(new Error(`sha256sum ${path} 失败（退出码 ${code}）`))
    })
  })
}


export class Files {
  constructor(private readonly k: Kernel, private readonly dir: string | undefined) {}

  /** A file a remote CLI sent, by its sha256, with the name it was sent under. */
  get(sha256: string): { path: string, sha256: string } | null {
    if (!this.dir || !SHA256.test(sha256)) return null
    const dir = join(this.dir, sha256)
    const name = existsSync(dir) ? readdirSync(dir).find(item => !item.endsWith('.part')) : undefined
    if (!name) return null
    const path = join(dir, name)
    // Kept files stay as long as they are used.
    const now = new Date(this.k.now())
    try { utimesSync(path, now, now) } catch {}
    return { path, sha256 }
  }

  /** The file a `sha256:<hex>` reference names, or an error saying to send it first. */
  resolve(sha256: string): { path: string, sha256: string } {
    const file = this.get(sha256)
    if (!file) throw new BoardError('invalid', `boardd 这里没有 sha256 ${sha256.slice(0, 12)}… 的文件，先传上来`)
    return file
  }

  /**
   * A file arrives in pieces: `PUT /api/files/:sha256?name=&offset=&total=` sends the bytes from `offset` onward, at most
   * `PIECE` of them, and the piece that brings the file to `total` finishes it (the sha256 of everything so far is
   * checked then). A piece that fails leaves what arrived; the next try asks `GET /api/files/:sha256` for `received`
   * and continues from there.
   *
   * Why pieces: on some RISC-V hosts Node's V8 segfaults on large request bodies — sometimes at 50 MB,
   * reliably at 100 MB, and every time with several large uploads at once — in a bare `node` server and in boardd
   * alike. A few megabytes per request never crashed it, and no connection is held for a 200 MB body.
   */
  async put(actor: string, sha256: string, name: string, body: AsyncIterable<Buffer>, options: { offset?: number | null, total?: number | null } = {}): Promise<Uploaded> {
    if (!this.dir) throw new BoardError('invalid', '这个 boardd 不接收文件')
    if (!SHA256.test(sha256)) throw new BoardError('invalid', `sha256 不对：${sha256}`)
    const safe = this.safeName(name)
    const total = options.total ?? null
    if (total !== null && (!Number.isInteger(total) || total < 0)) throw new BoardError('invalid', `total 不对：${options.total}`)
    const existing = this.get(sha256)
    if (existing) {
      const size = statSync(existing.path).size
      for await (const _ of body) {}
      if (total !== null && total !== size) throw new BoardError('invalid', `boardd 这里的同名文件是 ${size} 字节，和要传的 ${total} 字节不符（sha256 相同不该如此）`)
      return { sha256, size, received: size, done: true, stored: false }
    }
    this.expire()
    const dir = join(this.dir, sha256)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const part = join(dir, `${safe}.part`)
    let offset = options.offset ?? 0
    if (!Number.isInteger(offset) || offset < 0) throw new BoardError('invalid', `offset 不对：${options.offset}`)
    const have = statSync(part, { throwIfNoEntry: false })?.size ?? 0
    // Only a continuation of what is here is accepted: a different start would corrupt the file.
    if (offset !== have) throw new BoardError('invalid', `续传位置不对：要从第 ${offset} 字节开始传，但这里收到的是 ${have} 字节`)
    let size = offset
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length
        if (size - offset > PIECE) return done(new BoardError('invalid', `一次传太多了：每片最多 ${PIECE / 1024 / 1024} MB`))
        done(null, chunk)
      },
    })
    try {
      await pipeline(body as AsyncIterable<Buffer>, tap, createWriteStream(part, { flags: 'a', mode: 0o600 }))
      if (total !== null && size < total) return { sha256, size: total, received: size, done: false, stored: false }
      if (total !== null && size > total) throw new BoardError('invalid', `传多了：应该有 ${total} 字节，收到 ${size}`)
      if (!size) throw new BoardError('invalid', '文件是空的')
      const got = await sha256File(part)
      if (got !== sha256) throw new BoardError('invalid', `传上来的文件和 sha256 对不上（收到 ${size} 字节，sha256 ${got.slice(0, 12)}…）`)
      renameSync(part, join(dir, safe))
    } catch (error) {
      // What arrived stays for the retry; a bad sha256 is not worth resuming, so start over next time.
      if (error instanceof BoardError && /sha256 对不上/.test(error.message)) rmSync(part, { force: true })
      throw error
    }
    this.k.record(actor, null, 'file', `${safe} ${sha256.slice(0, 12)}`, true, `${size} 字节`)
    return { sha256, size, received: size, done: true, stored: true }
  }

  /** What an unfinished upload has so far (`done: false`), or null: the CLI resumes from `received`. */
  partial(sha256: string): Uploaded | null {
    if (!this.dir || !SHA256.test(sha256)) return null
    const dir = join(this.dir, sha256)
    if (!existsSync(dir)) return null
    const part = readdirSync(dir).find(item => item.endsWith('.part'))
    if (!part) return null
    return { sha256, size: 0, received: statSync(join(dir, part)).size, done: false, stored: false }
  }

  /**
   * A path on this machine for a file arriving by scp, and the id that adopts it. The client copies the bytes there
   * itself; only the small ticket and adopt requests go through boardd, so a 200 MB image never enters Node's request
   * body. The directory lives under the file store, so adopting is an atomic rename after the hash check.
   */
  ticket(sha256: string, name: string): { id: string, path: string } {
    if (!this.dir) throw new BoardError('invalid', '这个 boardd 不接收文件')
    if (!SHA256.test(sha256)) throw new BoardError('invalid', `sha256 不对：${sha256}`)
    this.expire()
    const id = randomUUID().replaceAll('-', '')
    const incoming = join(this.dir, '.incoming')
    // The ssh uploader is a different local user from boardd: its group may write (the deployment gives
    // `.incoming` that group and the setgid bit), but nobody else can list or read it.
    mkdirSync(incoming, { recursive: true, mode: 0o2770 })
    chmodSync(incoming, 0o2770)   // mkdir's mode is masked by boardd's umask
    const dir = join(incoming, id)
    mkdirSync(dir, { recursive: true, mode: 0o2770 })
    chmodSync(dir, 0o2770)
    return { id, path: join(dir, this.safeName(name)) }
  }

  /** Check the file a CLI copied to a `ticket` path and keep it under its sha256. Nothing is read into memory. */
  async adopt(actor: string, id: string, sha256: string, name: string): Promise<Uploaded> {
    if (!this.dir) throw new BoardError('invalid', '这个 boardd 不接收文件')
    if (!/^[0-9a-f]{32}$/.test(id)) throw new BoardError('invalid', `上传凭据不对：${id}`)
    if (!SHA256.test(sha256)) throw new BoardError('invalid', `sha256 不对：${sha256}`)
    const safe = this.safeName(name)
    const incoming = join(this.dir, '.incoming', id)
    const path = join(incoming, safe)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat || !stat.isFile()) throw new BoardError('invalid', `文件没有到 boardd 这台机器：${path}`)
    if (!stat.size) throw new BoardError('invalid', '传上来的文件是空的')
    const got = await sha256File(path)
    if (got !== sha256) {
      rmSync(incoming, { recursive: true, force: true })
      throw new BoardError('invalid', `传上来的文件和 sha256 对不上（收到 ${stat.size} 字节，sha256 ${got.slice(0, 12)}…）`)
    }
    const existing = this.get(sha256)
    if (existing) {
      rmSync(incoming, { recursive: true, force: true })
      return { sha256, size: stat.size, received: stat.size, done: true, stored: false }
    }
    const dir = join(this.dir, sha256)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    renameSync(path, join(dir, safe))
    rmSync(incoming, { recursive: true, force: true })
    this.k.record(actor, null, 'file', `${safe} ${sha256.slice(0, 12)}`, true, `${stat.size} 字节`)
    return { sha256, size: stat.size, received: stat.size, done: true, stored: true }
  }

  /**
   * A file a browser sends, which cannot hash gigabytes first: `begin` gives an id for its name and size, `piece` adds
   * at most `PIECE` bytes at a time from where it stopped, `status` says how much arrived so the browser resumes there,
   * and `seal` hashes the whole file here (with `sha256sum` when it is large) and keeps it under its sha256. It waits
   * beside the scp tickets, so the same expiry takes an upload nobody finished.
   */
  begin(name: string, size: number): { id: string, piece: number } {
    if (!this.dir) throw new BoardError('invalid', '这个 boardd 不接收文件')
    if (!Number.isInteger(size) || size <= 0) throw new BoardError('invalid', `文件大小不对：${size}`)
    this.expire()
    const id = randomUUID().replaceAll('-', '')
    const dir = join(this.dir, '.uploads', id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name: this.safeName(name), size }))
    return { id, piece: PIECE }
  }

  /** How much of an upload arrived: where the next piece starts. */
  status(id: string): { id: string, name: string, size: number, received: number } {
    const { dir, meta } = this.upload(id)
    return { id, name: meta.name, size: meta.size, received: statSync(join(dir, 'data'), { throwIfNoEntry: false })?.size ?? 0 }
  }

  /** Add the bytes from `offset` (exactly what arrived so far) on, at most `PIECE` of them and never past the size. */
  async piece(id: string, offset: number, body: AsyncIterable<Buffer>): Promise<{ received: number, size: number }> {
    const { dir, meta } = this.upload(id)
    const data = join(dir, 'data')
    const have = statSync(data, { throwIfNoEntry: false })?.size ?? 0
    if (!Number.isInteger(offset) || offset !== have) { for await (const _ of body) {} throw new BoardError('invalid', `续传位置不对：要从第 ${offset} 字节开始传，但这里收到的是 ${have} 字节`) }
    let size = offset
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length
        if (size - offset > PIECE) return done(new BoardError('invalid', `一次传太多了：每片最多 ${PIECE / 1024 / 1024} MB`))
        if (size > meta.size) return done(new BoardError('invalid', `传多了：文件是 ${meta.size} 字节`))
        done(null, chunk)
      },
    })
    try { await pipeline(body as AsyncIterable<Buffer>, tap, createWriteStream(data, { flags: 'a', mode: 0o600 })) }
    catch (error) {
      // A piece that went wrong leaves a partial tail: cut back to where it started, so a retry starts clean.
      try { truncateSync(data, offset) } catch {}
      throw error
    }
    const now = new Date(this.k.now())
    try { utimesSync(dir, now, now) } catch {}
    return { received: size, size: meta.size }
  }

  /** The whole file is here: hash it, keep it under its sha256 (once; a file already kept is reused), and forget the upload. */
  async seal(actor: string, id: string, expected?: string | null): Promise<Uploaded & { name: string }> {
    const { dir, meta } = this.upload(id)
    const data = join(dir, 'data')
    const got = statSync(data, { throwIfNoEntry: false })?.size ?? 0
    if (got !== meta.size) throw new BoardError('invalid', `还没传完：${got} / ${meta.size} 字节`)
    const sha256 = await sha256File(data)
    if (expected && expected !== sha256) { rmSync(dir, { recursive: true, force: true }); throw new BoardError('invalid', `传上来的文件和 sha256 对不上（sha256 ${sha256.slice(0, 12)}…）`) }
    const existing = this.get(sha256)
    if (existing) { rmSync(dir, { recursive: true, force: true }); return { sha256, size: got, received: got, done: true, stored: false, name: meta.name } }
    const keep = join(this.dir!, sha256)
    mkdirSync(keep, { recursive: true, mode: 0o700 })
    renameSync(data, join(keep, meta.name))
    rmSync(dir, { recursive: true, force: true })
    this.k.record(actor, null, 'file', `${meta.name} ${sha256.slice(0, 12)}`, true, `${got} 字节`)
    return { sha256, size: got, received: got, done: true, stored: true, name: meta.name }
  }

  /** Give an upload up: what arrived is removed. */
  abandon(id: string): void { const { dir } = this.upload(id); rmSync(dir, { recursive: true, force: true }) }

  private upload(id: string): { dir: string, meta: { name: string, size: number } } {
    if (!this.dir) throw new BoardError('invalid', '这个 boardd 不接收文件')
    if (!/^[0-9a-f]{32}$/.test(id)) throw new BoardError('invalid', `上传编号不对：${id}`)
    const dir = join(this.dir, '.uploads', id)
    let meta: { name: string, size: number }
    try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) } catch { throw new BoardError('not-found', `没有这个上传（${id}）：可能放太久被清掉了，重新开始传`) }
    return { dir, meta }
  }

  /** A fresh path for a file a command writes and boardd then keeps (see `put`); remove it when done. */
  scratch(): string {
    if (!this.dir) throw new BoardError('invalid', '这个 boardd 不接收文件')
    mkdirSync(join(this.dir, 'tmp'), { recursive: true, mode: 0o700 })
    return join(this.dir, 'tmp', randomUUID())
  }

  private safeName(name: string): string {
    return basename(name || 'file').replace(/[^A-Za-z0-9._+-]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file'
  }

  private expire() {
    const root = this.dir!
    const stale = (dir: string) => this.k.now() - statSync(dir).mtimeMs > KEEP_MS && !readdirSync(dir).some(file => this.k.now() - statSync(join(dir, file)).mtimeMs < KEEP_MS)
    for (const old of existsSync(root) ? readdirSync(root) : []) {
      const dir = join(root, old)
      try {
        // Uploads and copies wait one level down, each in a directory of its own.
        if (old === '.uploads' || old === '.incoming') { for (const id of readdirSync(dir)) { const at = join(dir, id); if (stale(at)) rmSync(at, { recursive: true, force: true }) } }
        else if (stale(dir)) rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  }
}
