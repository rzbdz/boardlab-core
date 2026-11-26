/**
 * Reaching other machines from boardd: ssh as boardd's user with boardd's own key, trying the ways in until one works,
 * and putting boardd's key on the machine so every later login is key-only. A module that sets a machine up (a board
 * host, a compile machine, a directory of images) uses it; it registers nothing.
 *
 * It is the core's, not a module's, because more than one module needs it and a module that comes from a market can
 * only import `boardlab`. One ssh surface for everyone: a distribution's module and a market's reach a machine the same
 * way, with the same key and the same known-hosts file.
 *
 * The ways in, in order: boardd's own key (`<state>/ssh/id_ed25519`); the service user's ssh setup (its ~/.ssh/config
 * aliases, keys and agent: "inherit"); then a password, given once, through SSH_ASKPASS (no sshpass, never on a command
 * line or in a file that stays). Each address is tried as written: an ssh alias, a DNS name or an IP.
 */
import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface Result { code: number | null, stdout: string, stderr: string }
/** A machine boardd can run commands on, as reached. */
export interface Executor {
  /** `user@host` as it ended up reachable (or `local`). */
  target: string
  local: boolean
  run(command: string, options?: { stdin?: string | Buffer, timeoutMs?: number, onLine?: (line: string) => void, signal?: AbortSignal }): Promise<Result>
  /** Copy a local file there. */
  put(local: string, remote: string, timeoutMs?: number): Promise<void>
}
/** How to get in, as a person gave it on the page. */
export interface Access { address: string, user?: string, port?: number, password?: string, jump?: string }

const SAFE = /^[A-Za-z0-9_.@:-]+$/

export class Hosts {
  readonly keyFile: string
  private readonly control: string
  private readonly knownHosts: string
  constructor(private readonly stateDir: string, private readonly ssh = 'ssh', private readonly scp = 'scp') {
    const dir = join(stateDir, 'ssh')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.keyFile = join(dir, 'id_ed25519')
    this.control = join(dir, 'cm')
    mkdirSync(this.control, { recursive: true, mode: 0o700 })
    this.knownHosts = join(dir, 'known_hosts')
  }

  /** boardd's own key, made the first time (public part returned). */
  async publicKey(): Promise<string> {
    if (!existsSync(this.keyFile)) await this.exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `boardlab@${process.env.HOSTNAME ?? 'boardd'}`, '-f', this.keyFile], {})
    return readFileSync(`${this.keyFile}.pub`, 'utf8').trim()
  }

  /**
   * For programs that run ssh themselves (git): `ssh` command lines for each way in without a password, in order:
   * boardd's own key, then this machine's ssh setup. Each is one shell word list, for GIT_SSH_COMMAND.
   */
  async sshCommands(): Promise<string[]> {
    await this.publicKey()
    const quote = (word: string) => /^[A-Za-z0-9_./=:%@+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
    return (['key', 'inherit'] as const).map(mode => [this.ssh, ...this.options({ address: '' }, mode)].map(quote).join(' '))
  }

  private options(access: Access, mode: 'key' | 'inherit' | 'password', askpass?: string): string[] {
    const common = ['-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${this.knownHosts} ~/.ssh/known_hosts`,
      '-o', 'ServerAliveInterval=15', ...(access.port ? ['-p', String(access.port)] : []), ...(access.jump ? ['-J', access.jump] : [])]
    if (mode === 'key') return [...common, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-i', this.keyFile, '-o', 'ControlMaster=auto', '-o', `ControlPath=${this.control}/%C`, '-o', 'ControlPersist=120']
    if (mode === 'inherit') return [...common, '-o', 'BatchMode=yes']
    return [...common, '-o', 'BatchMode=no', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', ...(askpass ? [] : [])]
  }

  private exec(command: string, args: string[], options: { env?: NodeJS.ProcessEnv, stdin?: string | Buffer, timeoutMs?: number, onLine?: (line: string) => void, signal?: AbortSignal }): Promise<Result> {
    return new Promise(resolve => {
      const child = spawn(command, args, { env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: !!options.env?.SSH_ASKPASS })
      let stdout = '', stderr = '', partial = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 120_000)
      // A command whose asker is gone (a search the page replaced) is stopped here, not left running on the machine.
      const stop = () => child.kill('SIGTERM')
      if (options.signal?.aborted) stop()
      else options.signal?.addEventListener('abort', stop, { once: true })
      child.stdout.on('data', (data: Buffer) => {
        stdout += data
        if (options.onLine) { const text = partial + data.toString(); const lines = text.split('\n'); partial = lines.pop() ?? ''; for (const line of lines) options.onLine(line.replace(/\r$/, '')) }
      })
      child.stderr.on('data', (data: Buffer) => { stderr += data })
      child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }) })
      child.on('close', code => { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); if (partial && options.onLine) options.onLine(partial); resolve({ code, stdout, stderr }) })
      child.stdin.on('error', () => {})
      child.stdin.end(options.stdin ?? '')
    })
  }

  /** A password through SSH_ASKPASS: a script that prints it, readable only by boardd, gone after the call. */
  private async withPassword<T>(password: string, run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const dir = join(this.stateDir, 'ssh', `askpass-${randomBytes(6).toString('hex')}`)
    mkdirSync(dir, { mode: 0o700 })
    const secret = join(dir, 'secret'), script = join(dir, 'askpass')
    writeFileSync(secret, password, { mode: 0o600 })
    writeFileSync(script, `#!/bin/sh\ncat '${secret}'\n`, { mode: 0o700 })
    chmodSync(script, 0o700)
    try { return await run({ ...process.env, SSH_ASKPASS: script, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY ?? ':0' }) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }

  private executor(target: string, opts: string[], env?: NodeJS.ProcessEnv): Executor {
    return {
      target, local: false,
      run: (command, options = {}) => this.exec(this.ssh, [...opts, target, command], { env, stdin: options.stdin, timeoutMs: options.timeoutMs, onLine: options.onLine, signal: options.signal }),
      put: async (local, remote, timeoutMs = 600_000) => {
        const scpOpts = opts.map(item => item === '-p' ? '-P' : item)
        const result = await this.exec(this.scp, ['-q', ...scpOpts, local, `${target}:${remote}`], { env, timeoutMs })
        if (result.code !== 0) throw new Error(`传 ${local} 到 ${target} 失败：${(result.stderr || result.stdout).trim().split('\n').at(-1)}`)
      },
    }
  }

  /** This machine itself, with no ssh. */
  local(): Executor {
    return {
      target: 'local', local: true,
      run: (command, options = {}) => this.exec('sh', ['-c', command], { stdin: options.stdin, timeoutMs: options.timeoutMs, onLine: options.onLine }),
      put: async (local, remote) => { const result = await this.exec('cp', [local, remote], {}); if (result.code !== 0) throw new Error(result.stderr.trim()) },
    }
  }

  /**
   * Get in: each address, each way in, until `true` answers. With a password, boardd's key is put on the machine, and
   * the executor returned logs in with the key. Says how each try went, for the page.
   */
  async reach(access: Access, progress: (line: string) => void = () => {}): Promise<Executor> {
    if (['local', 'localhost', '127.0.0.1', '::1'].includes(access.address.trim())) return this.local()
    for (const part of [access.address, access.user ?? '', access.jump ?? '']) if (part && !SAFE.test(part)) throw new Error(`不合法的地址或用户：${part}`)
    const target = access.user ? `${access.user}@${access.address}` : access.address
    const tries: string[] = []
    const ok = async (opts: string[], env?: NodeJS.ProcessEnv) => {
      const result = await this.exec(this.ssh, [...opts, target, 'true'], { env, timeoutMs: 25_000 })
      return result.code === 0 ? null : (result.stderr.trim().split('\n').filter(Boolean).at(-1) ?? `退出码 ${result.code}`)
    }
    const key = await this.publicKey()
    const addKey = `umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qF '${key}' ~/.ssh/authorized_keys || echo '${key}' >> ~/.ssh/authorized_keys`
    for (const [mode, label] of [['key', 'boardd 自己的密钥'], ['inherit', '这台机器上的 ssh 设置（继承）']] as const) {
      const why = await ok(this.options(access, mode))
      if (why) { tries.push(`${label}：${why}`); continue }
      progress(`用${label}连上了 ${target}`)
      if (mode === 'key') return this.executor(target, this.options(access, mode))
      // In by this machine's own ssh setup: put boardd's key there too, so boardd (and the lab) logs in with its own.
      const put = await this.exec(this.ssh, [...this.options(access, mode), target, addKey], { timeoutMs: 30_000 })
      if (put.code === 0 && !(await ok(this.options(access, 'key')))) { progress('放好了 boardd 的密钥，以后用它登录'); return this.executor(target, this.options(access, 'key')) }
      progress(`没能放 boardd 的密钥（${put.stderr.trim() || '用密钥还是登不上'}），继续用这台机器的 ssh 设置`)
      return this.executor(target, this.options(access, mode))
    }
    if (access.password) {
      const why = await this.withPassword(access.password, env => ok(this.options(access, 'password'), env))
      if (!why) {
        progress(`用密码连上了 ${target}，放 boardd 的密钥上去`)
        const put = await this.withPassword(access.password, env => this.exec(this.ssh, [...this.options(access, 'password'), target, addKey], { env, timeoutMs: 30_000 }))
        if (put.code !== 0) throw new Error(`放密钥到 ${target} 失败：${put.stderr.trim()}`)
        const again = await ok(this.options(access, 'key'))
        if (again) throw new Error(`放了密钥，但用它还是登不上 ${target}：${again}`)
        return this.executor(target, this.options(access, 'key'))
      }
      tries.push(`密码：${why}`)
    }
    throw new Error(`连不上 ${target}：${tries.join('；')}${access.password ? '' : '。给出密码试试，或者把 boardd 的公钥放到那台机器上'}`)
  }
}

let shared: Hosts | null = null
/** One per boardd (its state directory). */
export function hostsFor(stateDir: string): Hosts { return shared ??= new Hosts(stateDir) }

export const execFileText = (command: string, args: string[]) => new Promise<string>((resolve, reject) => execFile(command, args, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)))
