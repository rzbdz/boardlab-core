/**
 * Files remote CLIs and the page send to boardd (boot images, flash packages, files for SDK work), kept under their
 * sha256: the content is checked against it as it arrives, a file already here is not stored twice, and files unused for
 * three days are removed.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BoardError } from './errors.ts'
import type { Kernel } from './kernel.ts'

const KEEP_MS = 3 * 86_400_000
export const SHA256 = /^[0-9a-f]{64}$/

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

  async put(actor: string, sha256: string, name: string, body: AsyncIterable<Buffer>, limit = 16 * 1024 * 1024 * 1024): Promise<{ sha256: string, size: number, stored: boolean }> {
    if (!this.dir) throw new BoardError('invalid', '这个 boardd 不接收文件')
    if (!SHA256.test(sha256)) throw new BoardError('invalid', `sha256 不对：${sha256}`)
    const safe = basename(name || 'file').replace(/[^A-Za-z0-9._+-]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file'
    const existing = this.get(sha256)
    if (existing) { for await (const _ of body) {} return { sha256, size: statSync(existing.path).size, stored: false } }
    this.expire()
    const dir = join(this.dir, sha256)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const part = join(dir, `${safe}.${randomUUID()}.part`)
    const hasher = createHash('sha256')
    let size = 0
    const out = createWriteStream(part, { mode: 0o600 })
    try {
      for await (const chunk of body) {
        size += chunk.length
        if (size > limit) throw new BoardError('invalid', `文件太大（超过 ${limit / 1024 / 1024} MB）`)
        hasher.update(chunk)
        if (!out.write(chunk)) await new Promise<void>(resolve => out.once('drain', () => resolve()))
      }
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve()))
      const got = hasher.digest('hex')
      if (got !== sha256) throw new BoardError('invalid', `传上来的文件和 sha256 对不上（收到 ${size} 字节，sha256 ${got.slice(0, 12)}…）`)
      if (!size) throw new BoardError('invalid', '文件是空的')
      renameSync(part, join(dir, safe))
    } catch (error) {
      out.destroy()
      rmSync(part, { force: true })
      throw error
    }
    this.k.record(actor, null, 'file', `${safe} ${sha256.slice(0, 12)}`, true, `${size} 字节`)
    return { sha256, size, stored: true }
  }

  /** A fresh path for a file a command writes and boardd then keeps (see `put`); remove it when done. */
  scratch(): string {
    if (!this.dir) throw new BoardError('invalid', '这个 boardd 不接收文件')
    mkdirSync(join(this.dir, 'tmp'), { recursive: true, mode: 0o700 })
    return join(this.dir, 'tmp', randomUUID())
  }

  private expire() {
    const root = this.dir!
    for (const old of existsSync(root) ? readdirSync(root) : []) {
      const dir = join(root, old)
      try { if (this.k.now() - statSync(dir).mtimeMs > KEEP_MS && !readdirSync(dir).some(file => this.k.now() - statSync(join(dir, file)).mtimeMs < KEEP_MS)) rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }
}
