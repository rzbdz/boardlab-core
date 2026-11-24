/**
 * The core against fake backends: locks and queues, the backend contract (relay, consoles, download, leases, slots,
 * discovery, refresh), modules, configuration, the HTTP gateway and the CLI. Distributions test their modules.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardsClient, sshTransport, webTransport } from '../src/shared/client.ts'
import { agentHolder, consoleKeys, createCli, defaultHolder, parseArgs } from '../src/cli/main.ts'
import { openDatabase } from '../src/core/db.ts'
import { BoardLab, inLoadOrder } from '../src/core/lab.ts'
import { main } from '../bare/boardlab.ts'
import { BoardError } from '../src/core/errors.ts'
import { API_VERSION, type DiscoveryMethod, type LabFields } from '../src/shared/types.ts'
import type { Module } from '../src/core/module.ts'
import type { ConsoleSession } from '../src/core/console.ts'
import { serve } from '../src/server/http.ts'
import { RawReply } from '../src/core/api.ts'
import { parseConfig } from '../src/server/config.ts'
import { createModules, instances, type CatalogEntry } from '../src/server/catalog.ts'
import { deviceFilter, type Backend, type BoardTarget, type BootFile, type DiscoveryCapability, type DownloadCapability, type LabConfig, type LabDevice, type LabSlots, type PortTiming, type RelayCapability, type RenameCapability } from '../src/core/backend.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boardlab-core-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A console that echoes what is typed, after a prompt. */
function fakeSession(name: string, sent: string[]): ConsoleSession {
  const listeners = new Set<(data: Buffer) => void>()
  return {
    hello: { alias: name, device: null, baud: 115200, transport: 'test' }, history: ['[t] old line'],
    send: data => { sent.push(`${name}: ${data}`); setTimeout(() => listeners.forEach(fn => fn(Buffer.from(`${data}root@board:~# `))), 5) },
    onOutput: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    onClose: () => {},
    close: () => listeners.clear(),
  }
}

/** The default backend, for boards registered by hand: it resets them and has their consoles, and nothing more. */
class Here implements Backend {
  kind = '本机（测试）'
  resets: string[] = []
  sent: string[] = []
  relay: RelayCapability = {
    reset: async (_config, target) => { this.resets.push(target.board) },
    enterDownload: async (_config, target) => { this.resets.push(`${target.board} download`) },
  }
  serial: Backend['serial'] = { open: async (_config, target) => fakeSession(target.board, this.sent) }
  download: DownloadCapability = { stage: async () => 'OKAY', present: async () => true }
}

/** The settings the fake lab takes: an address, an account, and a jump host. */
const FAKE_LAB_FIELDS: LabFields = {
  url: { label: '后台地址', placeholder: 'http://lab.example:8080', required: true },
  username: { label: '账号', placeholder: null, required: true },
  password: { label: '密码', placeholder: '后台密码', required: true },
  jump: { label: '跳板机', placeholder: 'user@host', required: false },
}

/** A remote lab behind a fake management controller: power, consoles, and download ports on its jump host. */
class FakeLab implements Backend {
  kind = '测试实验室'
  fields = FAKE_LAB_FIELDS
  inventory: NonNullable<Backend['inventory']> = { verify: config => this.verify(config), devices: () => this.devices() }
  relay: RelayCapability = {
    reset: (config, target, notice) => this.reset(config, target.device, target.lease, notice),
    enterDownload: (config, target, notice) => this.fastboot(config, target.device, target.lease, notice),
  }
  serial: Backend['serial'] = { open: (config, target, options) => this.console(config, target.device, options) }
  download: DownloadCapability = {
    stage: (config, target, file) => this.stage(config, target.usbPath!, file),
    present: (config, target) => this.present(config, target.usbPath!),
  }
  calls: string[] = []
  sent: string[] = []
  staged: Array<{ usbPath: string, sha256: string }> = []
  gone = new Set<string>()
  listed: LabDevice[] = ['sub0-0', 'sub0-1', 'sub1-0'].map((name, index) => ({
    name, model: 'board-a', soc: 'test-soc', online: index !== 2, serialPort: `/dev/ttyS_${index}`, serialConnected: index !== 1, downloadUsbPath: `1-2.${index + 1}`, ip: `10.0.0.${index + 10}`,
  }))
  defaultJump(url: URL) { return `ubuntu@${url.hostname}` }
  async verify(config: LabConfig) {
    if (config.password !== 'lab-password') throw new Error('后台拒绝了账号或密码（401）')
    this.calls.push(`verify ${config.username} ${config.jump}`)
    return '后台登录正常，3 台设备'
  }
  async devices() { return this.listed.map(device => ({ ...device })) }
  async reset(_config: LabConfig, device: string, _lease?: string | null, _notice?: (message: string | null) => void): Promise<void> { this.calls.push(`reset ${device}`) }
  /** Set for a lab that learns a board's download port when it appears. */
  learned: string | null = null
  async fastboot(_config: LabConfig, device: string, _lease?: string | null, _notice?: (message: string | null) => void) { this.calls.push(`fastboot ${device}`); return this.learned ?? undefined }
  consoles: Array<{ device: string, history: boolean | undefined }> = []
  async console(_config: LabConfig, device: string, options: { history?: boolean } = {}): Promise<ConsoleSession> {
    this.consoles.push({ device, history: options.history })
    const listeners = new Set<(data: Buffer) => void>()
    return {
      hello: { alias: device, device: null, baud: 115200, transport: 'lab' }, history: [`[${device}] test-soc login:`],
      send: data => { this.sent.push(`${device}: ${data}`); setTimeout(() => listeners.forEach(fn => fn(Buffer.from(`${data}root@board-a:~# `))), 5) },
      onOutput: fn => { listeners.add(fn); return () => listeners.delete(fn) },
      onClose: () => {},
      close: () => listeners.clear(),
    }
  }
  async stage(_config: LabConfig, usbPath: string, file: { path: string, sha256: string }) { this.staged.push({ usbPath, sha256: file.sha256 }); return 'OKAY' }
  async present(_config: LabConfig, usbPath: string) { return !this.gone.has(usbPath) }
}

function coreLab<H extends Backend = Here>(options: { lab?: Backend, here?: H, now?: () => number } = {}) {
  const here = (options.here ?? new Here()) as H
  const lab = options.lab ?? new FakeLab()
  const svc = new BoardLab({
    db: openDatabase(join(dir, 'lab.sqlite')), now: options.now, sleep: async () => {}, firmwareDir: join(dir, 'firmware'), filesDir: join(dir, 'files'),
    bootTiming: { firstMs: 0, laterMs: 0, waitMs: 2, pollMs: 1 },
    modules: [
      { id: 'test-here', title: '本机（测试）', setup: core => core.backends.register('local', here, { configurable: false, isDefault: true }) },
      { id: 'test-labs', title: '测试实验室', setup: core => core.backends.register('lab1', lab) },
    ],
  })
  svc.boards.add('user:alice', { name: 'com260', slot: 1, chips: [{ serialPath: '/dev/ttyUSB1', alias: 'com260', downloadUsbPath: '3-2.3' }] })
  return { svc, lab: lab as any, here }
}
function labService(): { svc: BoardLab, lab: FakeLab, here: Here }
function labService<L extends Backend>(lab: L): { svc: BoardLab, lab: L, here: Here }
function labService(lab: Backend = new FakeLab()) { return coreLab({ lab }) }
const service = () => coreLab().svc
const enable = (svc: BoardLab, change: Partial<Parameters<BoardLab['backends']['configure']>[2]> = {}) =>
  svc.backends.configure('user:alice', 'lab1', { enabled: true, url: 'http://lab.test:8080/dashboard/modules', username: 'admin', password: 'lab-password', devices: 'sub0-*', ...change })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
/** Ship a firmware file the way a distribution's firmware/ does: the file plus its firmware.json entry. */
function shipFirmware(purpose: string, content: string, soc = 'test-soc') {
  const firmwareDir = join(dir, 'firmware')
  mkdirSync(firmwareDir, { recursive: true })
  writeFileSync(join(firmwareDir, `${purpose}.bin`), content)
  writeFileSync(join(firmwareDir, 'firmware.json'), JSON.stringify([{ soc, purpose, file: `${purpose}.bin`, sha256: sha(content) }]))
  return join(firmwareDir, `${purpose}.bin`)
}

describe('holders', () => {
  it('acts as the agent it runs in unless told otherwise, never as the person at the machine', () => {
    const keys = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT'] as const
    const saved = new Map(keys.map(key => [key, process.env[key]]))
    try {
      for (const key of keys) delete process.env[key]
      expect(defaultHolder('alice')).toBe('user:alice')
      expect(agentHolder()).toBeNull()
      process.env.AI_AGENT = 'opencode_1-2_agent'
      expect(defaultHolder('alice')).toBe('agent:opencode_1-2_agent')
      process.env.CLAUDECODE = '1'; process.env.CLAUDE_CODE_SESSION_ID = 'abc-123'
      expect(defaultHolder('alice')).toBe('claude:abc-123')
      expect(agentHolder()).toBe('claude:abc-123')
      // A session id that cannot be a holder's name falls back rather than making an invalid one.
      process.env.CLAUDE_CODE_SESSION_ID = 'a b'
      expect(defaultHolder('alice')).toBe('agent:opencode_1-2_agent')
    } finally {
      for (const key of keys) { const value = saved.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value }
    }
  })

  it('takes any agent kind as a holder, and never another person through the holder header', async () => {
    const { HOLDER } = await import('../src/core/text.ts')
    for (const ok of ['user:alice', 'claude:fix-mmc', 'codex:uboot-net-fix', 'opencode:ci-smoke', 'dsh:pcie', 'boardlab:user:bob']) expect(HOLDER.test(ok)).toBe(true)
    for (const bad of ['alice', 'Claude:x', 'user:', 'claude:has space', 'a-very-long-kind-name-of-more-than-32:x']) expect(HOLDER.test(bad)).toBe(false)
  })
})

describe('lab kinds', () => {
  it('adds labs of a kind a module offers at runtime, keeps them across restarts, and removes them while none of their boards is held', async () => {
    const made: string[] = []
    const kindModule: Module = { id: 'kinds', title: 'kinds', setup: lab => lab.backends.offer({ kind: 'fake', title: '假实验室', about: '测试用', create: id => { made.push(id); return new FakeLab() } }) }
    const file = join(dir, 'kinds.sqlite')
    const first = new BoardLab({ db: openDatabase(file), modules: [kindModule] })
    expect(first.backends.kindsOffered()).toEqual([{ kind: 'fake', title: '假实验室', about: '测试用' }])
    expect(() => first.backends.add('user:alice', 'lab 1', 'fake')).toThrow(/实验室名/)
    expect(() => first.backends.add('user:alice', 'lab1', 'nope')).toThrow(/没有这种实验室/)
    expect(first.backends.add('user:alice', 'lab1', 'fake')).toMatchObject({ id: 'lab1', kind: '测试实验室', addedAs: 'fake', enabled: false })
    expect(() => first.backends.add('user:alice', 'lab1', 'fake')).toThrow(/已经有/)
    await first.backends.configure('user:alice', 'lab1', { enabled: true, url: 'bspd+http://127.0.0.1:8765', username: 'admin', password: 'lab-password', devices: '' })
    await first.backends.sync('lab1')
    // Made again from what was kept, when boardd starts over.
    const again = new BoardLab({ db: openDatabase(file), modules: [kindModule] })
    expect(made).toEqual(['lab1', 'lab1'])
    expect(again.backends.labSettings()).toMatchObject([{ id: 'lab1', addedAs: 'fake', enabled: true, url: 'bspd+http://127.0.0.1:8765' }])
    const { token } = await again.locks.lock('lab1-sub0-0', 'user:bob', '调试')
    await expect(again.backends.removeLab('user:alice', 'lab1')).rejects.toThrow(/正被 user:bob 使用/)
    again.locks.unlock('lab1-sub0-0', { holder: 'user:bob', token })
    // Nor while something runs on the lab itself (an install): removing it would pull the lab out from under it.
    let installed!: () => void
    const installing = again.kernel.doing(['lab:lab1'], 'install', '安装中', 'user:carol', () => new Promise<void>(resolve => { installed = resolve }))
    await expect(again.backends.removeLab('user:alice', 'lab1')).rejects.toThrow(/正在安装（user:carol）/)
    installed(); await installing
    await again.backends.removeLab('user:alice', 'lab1')
    expect(again.backends.labSettings()).toEqual([])
    expect(again.boards.list().filter(board => board.name.startsWith('lab1-'))).toEqual([])
    expect(new BoardLab({ db: openDatabase(file), modules: [kindModule] }).backends.labSettings()).toEqual([])
  })

  it('takes a lab address of http, https, ssh or a backend\'s own scheme on them, and nothing else', async () => {
    const { svc } = labService()
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)']) await expect(enable(svc, { url })).rejects.toThrow(/http、https 或 ssh/)
    for (const url of ['ssh://root@host', 'bspd+http://127.0.0.1:8765']) expect((await enable(svc, { url })).url).toBe(url)
  })
})

describe('remote labs', () => {
  it('lists a lab\'s boards in its device range once enabled, and never reports the password', async () => {
    const { svc, lab } = labService()
    expect(svc.backends.labSettings()).toMatchObject([{ id: 'lab1', kind: '测试实验室', enabled: false, hasPassword: false }])
    await expect(enable(svc, { password: null })).rejects.toThrow(/先填密码/)
    const settings = await enable(svc)
    expect(settings).toMatchObject({ enabled: true, url: 'http://lab.test:8080/dashboard/modules', username: 'admin', hasPassword: true, jump: null, defaultJump: 'ubuntu@lab.test', devices: 'sub0-*', verifyOk: true, syncOk: true })
    expect(settings.syncMessage).toBe('列出 2 块（实验室共 3 台，范围 sub0-*）')
    expect(lab.calls).toEqual(['verify admin ubuntu@lab.test'])
    const listed = svc.boards.list().filter(board => board.lab)
    expect(listed.map(board => [board.name, board.lab, board.source, board.soc, board.slot])).toEqual([
      ['lab1-sub0-0', { id: 'lab1', device: 'sub0-0', online: true, ip: '10.0.0.10', heldBy: null, leaseError: null, attention: null, attentionRequest: null, canConfirm: false, empty: false, slotGone: false, canRefresh: false, mediaBoot: null, sdks: [], progress: null, canFlashPackage: false, packages: null, canPlan: false, debug: null }, 'lab', 'test-soc', null],
      ['lab1-sub0-1', { id: 'lab1', device: 'sub0-1', online: true, ip: '10.0.0.11', heldBy: null, leaseError: null, attention: null, attentionRequest: null, canConfirm: false, empty: false, slotGone: false, canRefresh: false, mediaBoot: null, sdks: [], progress: null, canFlashPackage: false, packages: null, canPlan: false, debug: null }, 'lab', 'test-soc', null],
    ])
    expect(listed.map(board => board.chips.map(chip => [chip.serialPath, chip.downloadUsbPath, chip.online, chip.alias]))).toEqual([[['/dev/ttyS_0', '1-2.1', true, null]], [['/dev/ttyS_1', '1-2.2', false, null]]])
    // Missing inventory fields do not erase the model or SoC already known.
    lab.listed[0]!.model = null
    lab.listed[0]!.soc = undefined
    await svc.backends.sync('lab1')
    expect(svc.boards.get('lab1-sub0-0')).toMatchObject({ product: 'board-a', soc: 'test-soc' })
    // The password stays write-only, a wrong one is reported without echoing it, and saving without one keeps it.
    const bad = await enable(svc, { password: 'wrong-password' })
    expect(bad).toMatchObject({ verifyOk: false, verifyMessage: '后台拒绝了账号或密码（401）' })
    expect((await enable(svc, { password: 'lab-password', jump: 'ops@lab.test:2222' })).verifyOk).toBe(true)
    expect((await enable(svc, { password: null, jump: 'ops@lab.test:2222' })).verifyOk).toBe(true)
    expect(lab.calls.at(-1)).toBe('verify admin ops@lab.test:2222')
    expect(JSON.stringify([svc.state('user:alice'), svc.history()])).not.toMatch(/lab-password|wrong-password/)
    // Forgetting it takes saying so: omitted, null or empty keep it (a form saved without retyping it).
    await enable(svc, { password: '', jump: 'ops@lab.test:2222' })
    expect(svc.backends.config('lab1').password).toBe('lab-password')
    await expect(enable(svc, { password: null, clearPassword: true })).rejects.toThrow(/先填密码/)
    expect(svc.backends.config('lab1').password).toBe('lab-password')
    await svc.backends.configure('user:alice', 'lab1', { enabled: false, clearPassword: true })
    expect(svc.backends.labSettings()).toMatchObject([{ id: 'lab1', hasPassword: false }])
    expect(svc.history().actions.find(action => action.kind === 'lab-config')).toMatchObject({ message: '已去掉密码' })
    await enable(svc, { jump: 'ops@lab.test:2222' })
    await expect(enable(svc, { jump: 'not a host' })).rejects.toThrow(/跳板机格式不对/)
    await expect(enable(svc, { devices: 'sub0-0; rm' })).rejects.toThrow(/不合法的名字/)
    // Lab boards follow the lab: they are not removed by hand, exported, or given a slot.
    await expect(svc.boards.remove('user:alice', 'lab1-sub0-0')).rejects.toThrow(/跟着实验室/)
    expect(() => svc.boards.update('user:alice', 'lab1-sub0-0', { slot: 3 })).toThrow(/没有控制槽位/)
    expect(svc.boards.exportToml()).not.toContain('lab1')
  })

  it('takes boards that left the range off the list unless someone holds them, and switches off only when none is held', async () => {
    const { svc, lab } = labService()
    await enable(svc, { devices: '' })
    expect(svc.boards.list().filter(board => board.lab).map(board => board.name)).toEqual(['lab1-sub0-0', 'lab1-sub0-1', 'lab1-sub1-0'])
    await svc.locks.lock('lab1-sub0-1', 'claude:s1', '调试')
    await svc.locks.lock('lab1-sub1-0', 'claude:s2', '调试', { queue: 'join' })
    await svc.locks.lock('lab1-sub1-0', 'user:alice', '排队', { queue: 'join' })
    lab.listed = lab.listed.filter(device => device.name !== 'sub0-0')
    await enable(svc, { devices: 'sub1-*' })
    expect(svc.boards.list().filter(board => board.lab).map(board => board.name)).toEqual(['lab1-sub0-1', 'lab1-sub1-0'])
    expect(svc.backends.labSettings()[0]!.syncMessage).toBe('列出 1 块（实验室共 2 台，范围 sub1-*）；lab1-sub0-1 已经不在范围里，有人在用，先留着')
    await expect(svc.backends.configure('user:alice', 'lab1', { enabled: false })).rejects.toThrow(/lab1-sub\d-\d 正被 claude:s\d 使用/)
    svc.locks.unlock('lab1-sub0-1', { holder: 'claude:s1', token: (await svc.locks.lock('lab1-sub0-1', 'claude:s1', '调试')).token })
    svc.locks.unlock('lab1-sub1-0', { holder: 'claude:s2', token: (await svc.locks.lock('lab1-sub1-0', 'claude:s2', '调试')).token })
    svc.locks.unlock('lab1-sub1-0', { holder: 'user:alice' })
    const off = await svc.backends.configure('user:alice', 'lab1', { enabled: false, url: 'http://lab.test:8080', username: 'admin' })
    expect(off).toMatchObject({ enabled: false, hasPassword: true })
    expect(svc.boards.list().map(board => board.name)).toEqual(['com260'])
    await svc.backends.syncAll()
    expect(svc.boards.list().map(board => board.name)).toEqual(['com260'])
  })

  it('drives a lab board through its lab under the same lease as a board here', async () => {
    const { svc, lab } = labService()
    await enable(svc)
    await expect(svc.relay.reset('lab1-sub0-0', { holder: 'claude:s1' })).rejects.toThrow(/请先拿/)
    const { token } = await svc.locks.lock('lab1-sub0-0', 'claude:s1', '内存启动')
    const claude = { holder: 'claude:s1', token }
    await svc.relay.fastboot('lab1-sub0-0', claude)
    expect(svc.boards.get('lab1-sub0-0').mode).toBe('fastboot')
    await svc.relay.reset('lab1-sub0-0', claude)
    expect(lab.calls.slice(1)).toEqual(['fastboot sub0-0', 'reset sub0-0'])
    expect(svc.boards.detail('lab1-sub0-0').actions.filter(action => action.kind === 'reset' || action.kind === 'fastboot').map(action => action.detail)).toEqual(['lab1 sub0-0', 'lab1 sub0-0'])

    expect(await svc.consoles.send('lab1-sub0-0', claude, { text: 'uname -a', wait: 'root@board-a' })).toMatchObject({ matched: true })
    expect(lab.sent).toEqual(['sub0-0: uname -a\n'])
    expect(await svc.consoles.log('lab1-sub0-0')).toEqual(['[sub0-0] test-soc login:'])
    // A listing that says the port is down can be a minute old; opening the console asks the lab.
    expect(svc.boards.get('lab1-sub0-1').chips[0]!.online).toBe(false)
    expect((await svc.consoles.open('lab1-sub0-1')).history).toEqual(['[sub0-1] test-soc login:'])

    const fsbl = shipFirmware('fsbl', 'shipped FSBL')
    const kernel = join(dir, 'Image.itb')
    writeFileSync(kernel, 'kernel FIT')
    await svc.download.stage('lab1-sub0-0', claude, { firmware: 'fsbl' })
    expect(lab.staged).toEqual([{ usbPath: '1-2.1', sha256: sha('shipped FSBL') }])
    lab.staged.length = 0
    const output = await svc.download.boot('lab1-sub0-0', claude, { files: ['fsbl', kernel] })
    expect(lab.staged).toEqual([{ usbPath: '1-2.1', sha256: sha('shipped FSBL') }, { usbPath: '1-2.1', sha256: sha('kernel FIT') }])
    expect(output).toContain(`1. ${fsbl}`)
    lab.gone.add('1-2.1')
    await expect(svc.download.boot('lab1-sub0-0', claude, { files: ['fsbl', kernel] })).rejects.toThrow(/第 2 个文件.*没有重新出现/)
    // Boards here still go through their slots and the fastboot on this machine.
    expect(svc.boards.get('com260').lab).toBeNull()
  })

  it('keeps the download port a lab learned when the board entered download mode, and reads no backlog to send input', async () => {
    const { svc, lab } = labService()
    lab.listed = lab.listed.map(device => ({ ...device, downloadUsbPath: null }))
    await enable(svc)
    const { token } = await svc.locks.lock('lab1-sub0-0', 'claude:s1', '内存启动')
    lab.learned = '7-1.4'
    await svc.relay.fastboot('lab1-sub0-0', { holder: 'claude:s1', token })
    expect(svc.boards.get('lab1-sub0-0').chips[0]!.downloadUsbPath).toBe('7-1.4')
    expect(svc.boards.detail('lab1-sub0-0').actions.find(action => action.kind === 'fastboot')?.message).toBe('下载口 7-1.4')
    await svc.backends.sync('lab1')
    expect(svc.boards.get('lab1-sub0-0').chips[0]!.downloadUsbPath).toBe('7-1.4')
    await svc.consoles.send('lab1-sub0-0', { holder: 'claude:s1', token }, { text: 'uname -a', wait: 'root@board-a' })
    await svc.consoles.log('lab1-sub0-0')
    expect(lab.consoles).toEqual([{ device: 'sub0-0', history: false }, { device: 'sub0-0', history: true }])
  })

  it('holds the lab\'s own lease while a lab board is locked, renamed on handover and given back when free', async () => {
    /** A lab with leases of its own, like bsp: tokens per board, refused while someone else holds it. */
    class LeasedLab extends FakeLab {
      leases = new Map<string, { holder: string, token: string }>()
      seq = 0
      leaseCalls: string[] = []
      async lock(_config: LabConfig, device: string, who: { holder: string, purpose: string, token: string | null }) {
        const held = this.leases.get(device)
        if (held && held.token !== who.token) throw new Error(`leased by ${held.holder}`)
        const token = held?.token ?? `t${++this.seq}`
        this.leases.set(device, { holder: who.holder, token })
        this.leaseCalls.push(`lock ${device} ${who.holder} ${who.token ?? '-'}`)
        return token
      }
      async unlock(_config: LabConfig, device: string, token: string) {
        if (this.leases.get(device)?.token === token) this.leases.delete(device)
        this.leaseCalls.push(`unlock ${device} ${token}`)
      }
      leaseSeen: Array<string | null | undefined> = []
      async reset(config: LabConfig, device: string, lease?: string | null) { this.leaseSeen.push(lease); return super.reset(config, device) }
      lease = { take: (config: LabConfig, device: string, who: { holder: string, purpose: string, token: string | null }) => this.lock(config, device, who), give: (config: LabConfig, device: string, token: string) => this.unlock(config, device, token) }
    }
    const lab = new LeasedLab()
    const { svc } = labService(lab)
    await enable(svc)
    const alice = await svc.locks.lock('lab1-sub0-0', 'claude:alice', '调试')
    expect(lab.leases.get('sub0-0')).toEqual({ holder: 'boardlab:claude:alice', token: 't1' })
    await svc.relay.reset('lab1-sub0-0', { holder: 'claude:alice', token: alice.token })
    expect(lab.leaseSeen).toEqual(['t1'])
    // The lease is renewed at every sync and follows the lock to whoever queued for it.
    await svc.backends.sync('lab1')
    await svc.locks.lock('lab1-sub0-0', 'user:bob', '排队', { queue: 'join' })
    svc.locks.unlock('lab1-sub0-0', { holder: 'claude:alice', token: alice.token })
    await svc.locks.settle('lab1-sub0-0')
    expect(lab.leases.get('sub0-0')).toEqual({ holder: 'boardlab:user:bob', token: 't1' })
    svc.locks.unlock('lab1-sub0-0', { holder: 'user:bob' })
    await svc.locks.settle('lab1-sub0-0')
    expect(lab.leases.has('sub0-0')).toBe(false)
    expect(lab.leaseCalls).toEqual(['lock sub0-0 boardlab:claude:alice -', 'lock sub0-0 boardlab:claude:alice t1', 'lock sub0-0 boardlab:user:bob t1', 'unlock sub0-0 t1'])
    // Someone holding a board in the lab itself: boardd refuses the lock, queues, and grants it once they let go.
    lab.leases.set('sub0-1', { holder: 'carol', token: 'theirs' })
    lab.listed[1]!.heldBy = 'carol'
    await svc.backends.sync('lab1')
    expect(svc.boards.get('lab1-sub0-1').lab?.heldBy).toBe('carol')
    await expect(svc.locks.lock('lab1-sub0-1', 'claude:alice', '调试')).rejects.toThrow(/在实验室里正被 carol 使用/)
    expect((await svc.locks.lock('lab1-sub0-1', 'claude:alice', '调试', { queue: 'join' })).queued).toEqual({ position: 1 })
    lab.leases.delete('sub0-1')
    lab.listed[1]!.heldBy = null
    await svc.backends.sync('lab1')
    await svc.locks.settle('lab1-sub0-1')
    expect(svc.boards.get('lab1-sub0-1').lease?.holder).toBe('claude:alice')
    expect(lab.leases.get('sub0-1')?.holder).toBe('boardlab:claude:alice')
    // A lab that refuses the lease (taken in the lab meanwhile, not yet listed) refuses the lock too.
    lab.leases.set('sub1-0', { holder: 'someone', token: 'x' })
    await enable(svc, { devices: '' })
    await expect(svc.locks.lock('lab1-sub1-0', 'user:carol', '调试')).rejects.toThrow(/实验室没有让出 lab1-sub1-0：leased by someone/)
    expect(svc.boards.get('lab1-sub1-0').lease).toBeNull()
  })

  it('hands a lab that boots by itself the whole file sequence in one call', async () => {
    class BootingLab extends FakeLab {
      boots: Array<{ files: BootFile[], lease: string | null }> = []
      constructor() {
        super()
        this.download.backendFiles = true
        this.download.boot = async (_config, target, files) => {
          this.boots.push({ files, lease: target.lease })
          return 'job boot-1 succeeded'
        }
      }
    }
    const lab = new BootingLab()
    const { svc } = labService(lab)
    await enable(svc)
    expect(() => svc.locks.unlock('no-such-board', { holder: 'user:alice' })).toThrow(/没有这块板/)
    const { token } = await svc.locks.lock('lab1-sub0-0', 'claude:s1', '内存启动')
    shipFirmware('fsbl', 'shipped FSBL')
    const kernel = join(dir, 'Image.itb')
    writeFileSync(kernel, 'kernel FIT')
    const output = await svc.download.boot('lab1-sub0-0', { holder: 'claude:s1', token },
      { files: ['fsbl', kernel, 'host:/products/Image.itb', 'https://images.test/kernel.itb'] })
    expect(lab.boots).toEqual([{ lease: null, files: [
      { path: expect.stringMatching(/fsbl/), sha256: sha('shipped FSBL') },
      { path: kernel, sha256: sha('kernel FIT') },
      { path: '/products/Image.itb', sha256: '', source: 'backend' },
      { path: 'https://images.test/kernel.itb', sha256: '', source: 'backend' },
    ] }])
    expect(lab.staged).toEqual([])
    expect(output).toContain('job boot-1 succeeded')
    await expect(svc.download.boot('lab1-sub0-0', { holder: 'claude:s1', token }, { files: ['host:relative'] })).rejects.toThrow(/host:\/绝对路径/)
    await expect(svc.download.boot('lab1-sub0-0', { holder: 'claude:s1', token }, { files: ['https://u:p@images.test/kernel'] })).rejects.toThrow(/不能带账号密码/)
    lab.download.backendFiles = false
    await expect(svc.download.boot('lab1-sub0-0', { holder: 'claude:s1', token }, { files: ['host:/products/Image.itb'] })).rejects.toThrow(/这个实验室不能/)
  })

  it('registers a board a person described through the compose method alone, and records a failed one', async () => {
    // A compose method describes a board rather than finding one: no scan runs, nothing on the board is touched, and
    // no confirmation is asked. The two kinds of method are not interchangeable, and core is what keeps them apart.
    class ComposeLab extends FakeLab {
      made: string[] = []
      refuse = false
      async methods(): Promise<DiscoveryMethod[]> {
        return [
          { id: 'scan', title: '自动发现', about: '逐个拉复位线' },
          { id: 'note', title: '手工登记', about: '说出板子是什么', compose: true, fields: [
            { id: 'name', label: '板名', kind: 'text' as const, required: true },
            { id: 'pins', label: '引脚', kind: 'text' as const }] },
        ]
      }
      async run(): Promise<{ message: string, found: [] }> { throw new Error('a compose method must not be run as a scan') }
      async register(): Promise<void> {}
      async compose(_config: LabConfig, method: string, values: Record<string, string>) {
        if (this.refuse) throw new Error('主机上没有这个名字')
        this.made.push(`${method} ${values.name} ${values.pins ?? ''}`.trim())
        return { name: values.name!, message: `登记了 ${values.name}` }
      }
      discovery: DiscoveryCapability = { methods: this.methods.bind(this), run: this.run.bind(this), register: this.register.bind(this), compose: this.compose.bind(this) }
    }
    const lab = new ComposeLab()
    const { svc } = labService(lab)
    await enable(svc)
    expect(await svc.backends.compose('user:alice', 'lab1', { method: 'note', values: { name: 'ec1', pins: '11,13' } }))
      .toMatchObject({ name: 'ec1', message: '登记了 ec1' })
    expect(lab.made).toEqual(['note ec1 11,13'])
    // A required field is checked by core, from the method's own fields.
    await expect(svc.backends.compose('user:alice', 'lab1', { method: 'note', values: {} })).rejects.toThrow(/板名/)
    // Each kind refuses the other's method, in both directions.
    await expect(svc.backends.compose('user:alice', 'lab1', { method: 'scan', values: {} })).rejects.toThrow(/不是手工登记/)
    await expect(svc.backends.discover('user:alice', 'lab1', true, { method: 'note', values: { name: 'x' } })).rejects.toThrow(/不是发现方法/)
    // A register the backend refused is in the history as a failure, not missing from it.
    lab.refuse = true
    await expect(svc.backends.compose('user:alice', 'lab1', { method: 'note', values: { name: 'ec2' } })).rejects.toThrow(/没有这个名字/)
    const failed = svc.kernel.db.prepare("SELECT ok, message FROM actions WHERE kind='lab-compose' ORDER BY id DESC LIMIT 1").get()
    expect(failed).toMatchObject({ ok: 0, message: '主机上没有这个名字' })
  })

  it('lets a lab with its own registry find new boards while others are held, and forget a board only while nobody holds it', async () => {
    class RegistryLab extends FakeLab {
      hang = false
      async methods(_config: LabConfig, context: { host?: string | null }) {
        const hostField = { id: 'host', label: '主机', kind: 'choice' as const, required: true, options: [{ value: 'lab-9', label: 'lab-9' }], initial: 'lab-9' }
        return [
          { id: 'gpio', title: '按复位线发现', about: '逐个拉复位线', fields: [...(context.host ? [] : [hostField]), { id: 'prefer', label: '先试这些复位线', kind: 'text' as const, required: false }] },
          { id: 'human', title: '人工发现', about: '按提示让板子进下载模式', fields: context.host ? [] : [hostField] },
        ]
      }
      async run(_config: LabConfig, method: string, values: { host?: string, prefer?: string }, context: { host?: string | null }, progress: (line: string) => void, _registered?: unknown, signal?: AbortSignal) {
        progress('ACTION NEEDED (board 1): put ONE unregistered board into download mode')
        const host = context.host ?? values.host
        this.calls.push(`discover ${method}${method === 'human' ? ` ${host}` : ''}`)
        if (values.prefer) this.calls.push(`prefer ${values.prefer}`)
        if ((values as Record<string, string>).nope) this.calls.push('nope')
        if (this.hang) await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled'))))
        return { message: '发现 1 块新板子', found: [{ host: 'lab-9', name: 'k3-board', summary: 'lab-9 上的新板子', warnings: [], detail: { console: 'c9' } }] }
      }
      async slots() { return [{ host: 'lab-9', consoles: [{ id: '/dev/ttyUSB5', label: '/dev/ttyUSB5' }, { id: 'ttyUSB5', label: '/dev/ttyUSB5' }], usb: [{ id: 'usb:1-3', label: 'usb:1-3 DFU' }] }] }
      async register(_config: LabConfig, finding: { detail: unknown }, name: string) {
        this.listed.push({ ...this.listed[0]!, name, heldBy: null }); this.calls.push(`register ${name} ${JSON.stringify(finding.detail)}`)
      }
      async remove(_config: LabConfig, device: string) { this.listed = this.listed.filter(item => item.name !== device); this.calls.push(`remove ${device}`) }
      discovery = { methods: this.methods.bind(this), run: this.run.bind(this), register: this.register.bind(this) }
      ports = { list: this.slots.bind(this) }
      constructor() { super(); this.inventory.remove = this.remove.bind(this) }
    }
    const lab = new RegistryLab()
    const { svc } = labService(lab)
    await enable(svc)
    expect(svc.backends.labSettings()[0]).toMatchObject({ canDiscover: true, canRemove: true })
    await expect(svc.backends.discover('user:alice', 'lab1', false, { method: 'gpio' })).rejects.toThrow(/需要用户确认/)
    expect((await svc.backends.discoveryMethods('lab1')).map(method => method.id)).toEqual(['gpio', 'human'])
    const { token } = await svc.locks.lock('lab1-sub0-0', 'claude:s1', '调试')
    // Finding boards uses only free lines and consoles: a board in use does not stop it. A method that needs a host
    // says so in its fields; the person's answer travels as one of its values.
    expect(await svc.backends.discover('user:alice', 'lab1', true, { method: 'gpio', values: { host: 'lab-9' } })).toMatchObject({ message: '发现 1 块新板子' })
    expect(await svc.backends.discover('user:alice', 'lab1', true, { method: 'gpio', values: { host: 'lab-9', prefer: '12,13' } })).toMatchObject({ message: '发现 1 块新板子' })
    expect(lab.calls).toContain('prefer 12,13')
    // A required field left empty, and a choice outside the backend's options, are refused before it runs.
    await expect(svc.backends.discover('user:alice', 'lab1', true, { method: 'gpio' })).rejects.toThrow(/需要主机/)
    // A value the backend never reported is not passed on.
    await svc.backends.discover('user:alice', 'lab1', true, { method: 'gpio', values: { host: 'lab-9', nope: 'x' } })
    expect(lab.calls).not.toContain('nope')
    await expect(svc.backends.discover('user:alice', 'lab1', true, { method: 'human', values: { host: 'lab-8' } })).rejects.toThrow(/不是可选项/)
    // A field the backend did not report is not sent; one of its choices is checked.
    await expect(svc.backends.discover('user:alice', 'lab1', true, { method: 'nope' })).rejects.toThrow(/没有发现方法/)
    lab.hang = true
    const running = svc.backends.discover('user:alice', 'lab1', true, { method: 'gpio', values: { host: 'lab-9' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await svc.backends.cancelDiscovery('user:alice', 'lab1')).toMatchObject({ message: expect.stringContaining('停下') })
    await expect(running).rejects.toThrow(/已取消/)
    expect(svc.backends.labSettings()[0]!.discovery).toMatchObject({ running: false, line: '已取消' })
    lab.hang = false
    await expect(svc.boards.remove('user:alice', 'lab1-sub0-0')).rejects.toThrow(/正被 claude:s1 使用/)
    svc.locks.unlock('lab1-sub0-0', { holder: 'claude:s1', token })
    const seen: string[] = []
    svc.events.on('event', () => { const line = svc.backends.labSettings()[0]!.discovery?.line; if (line && seen.at(-1) !== line) seen.push(line) })
    expect(await svc.backends.discover('user:alice', 'lab1', true, { method: 'human', host: 'lab-9' })).toEqual({ message: '发现 1 块新板子', proposals: 1, registered: [] })
    expect(seen.slice(0, 2)).toEqual(['人工发现（lab-9）', 'ACTION NEEDED (board 1): put ONE unregistered board into download mode'])
    expect(svc.backends.labSettings()[0]!.discovery).toMatchObject({ running: false, line: '发现 1 块新板子' })
    // Nothing is registered until the proposal is applied, under the name the person gives.
    expect(svc.boards.list().map(board => board.name)).not.toContain('lab1-sub0-9')
    const [proposal] = svc.state('user:alice').proposals
    expect(proposal).toMatchObject({ kind: 'new-board', summary: 'lab-9 上的新板子', change: { lab: 'lab1', name: 'k3-board' } })
    await expect(svc.proposals.resolve('user:alice', [proposal!.id], 'apply', { [proposal!.id]: 'bad name' })).rejects.toThrow(/板名不合法/)
    await svc.proposals.resolve('user:alice', [proposal!.id], 'apply', { [proposal!.id]: 'sub0-9' })
    expect(svc.state('user:alice').proposals).toEqual([])
    await expect(svc.backends.discover('user:alice', 'lab1', true, { method: 'human', host: 'bad host' })).rejects.toThrow(/主机名不合法/)
    expect(svc.boards.list().map(board => board.name)).toContain('lab1-sub0-9')
    await svc.boards.remove('user:alice', 'lab1-sub0-9')
    expect(svc.boards.list().map(board => board.name)).not.toContain('lab1-sub0-9')
    await svc.backends.sync('lab1')
    expect(svc.boards.list().map(board => board.name)).not.toContain('lab1-sub0-9')
    // Free ports a new cable shows up as are reported for a registration method's choices.
    expect(svc.backends.labSettings()[0]!.canListPorts).toBe(true)
    // The first ask has nothing to show yet and asks in the background; afterwards the answer is shown at once.
    expect(await svc.backends.ports('lab1')).toMatchObject({ hosts: [], at: null, refreshing: true })
    await svc.backends.refreshPorts('lab1')
    expect(await svc.backends.ports('lab1')).toMatchObject({ hosts: [{ host: 'lab-9', consoles: [{ id: '/dev/ttyUSB5', label: '/dev/ttyUSB5' }, { id: 'ttyUSB5', label: '/dev/ttyUSB5' }], usb: [{ id: 'usb:1-3', label: 'usb:1-3 DFU' }] }], refreshing: false, error: null })
    expect(lab.calls.filter(call => !call.startsWith('verify'))).toEqual(['discover gpio', 'discover gpio', 'prefer 12,13', 'discover gpio', 'discover gpio',
      'discover human lab-9', 'register sub0-9 {"console":"c9"}', 'remove sub0-9'])
  })

  it('shows what a person must do while a lab board\'s reset waits for them, and lets them confirm', async () => {
    class HumanLab extends FakeLab {
      release: (() => void) | null = null
      async reset(_config: LabConfig, _device: string, _lease?: string | null, notice?: (message: string | null, request?: string | null) => void) {
        notice?.('press RESET on slot-1', 'req-1')
        await new Promise<void>(resolve => { this.release = resolve })
        notice?.(null)
      }
      async confirm(_config: LabConfig, device: string, note: string, request?: string | null) {
        this.calls.push(`confirm ${device} ${note} ${request ?? '-'}`); this.release?.(); return '已确认「reset」'
      }
      constructor() { super(); this.relay.confirm = (config, target, note, request) => this.confirm(config, target.device, note, request) }
    }
    const lab = new HumanLab()
    const { svc } = labService(lab)
    await enable(svc)
    const { token } = await svc.locks.lock('lab1-sub0-0', 'claude:s1', '调试')
    const told: unknown[] = []
    svc.events.on('event', event => { if (event.type === 'attention') told.push(event) })
    const reset = svc.relay.reset('lab1-sub0-0', { holder: 'claude:s1', token })
    await new Promise(resolve => setTimeout(resolve, 5))
    // The ask carries the lab's id for it, so the page can send it back with the confirmation.
    expect(svc.boards.get('lab1-sub0-0').lab).toMatchObject({ attention: 'press RESET on slot-1', attentionRequest: 'req-1', canConfirm: true })
    // The person at the board confirms; they need not hold the lock, and the id travels with it.
    expect(await svc.relay.confirm('lab1-sub0-0', 'user:alice', '按了', 'req-1')).toBe('已确认「reset」')
    await reset
    expect(svc.boards.get('lab1-sub0-0').lab?.attention).toBeNull()
    expect(told).toEqual([
      { type: 'attention', board: 'lab1-sub0-0', message: 'press RESET on slot-1', request: 'req-1', holder: 'claude:s1' },
      { type: 'attention', board: 'lab1-sub0-0', message: null, request: null, holder: 'claude:s1' },
    ])
    expect(lab.calls.at(-1)).toBe('confirm sub0-0 按了 req-1')
    await expect(svc.relay.confirm('com260', 'user:alice')).rejects.toThrow(/没有在等人操作/)
  })

  it('shares one console session among its viewers and closes it once they are gone', async () => {
    let clock = 1_000_000
    const lab = new FakeLab()
    const { svc } = coreLab({ lab, now: () => clock })
    await enable(svc)
    const a = await svc.consoles.open('lab1-sub0-0')
    const b = await svc.consoles.open('lab1-sub0-0')
    expect(lab.consoles).toHaveLength(1)
    expect(svc.consoles.reap().watching).toEqual([{ console: 'lab1-sub0-0.die0', viewers: 2 }])
    a.close(); a.close()
    expect(svc.consoles.reap().watching).toEqual([{ console: 'lab1-sub0-0.die0', viewers: 1 }])
    b.close()
    // A viewer coming back soon reuses the session; one long gone has it closed by the reaper.
    const again = await svc.consoles.open('lab1-sub0-0')
    expect(lab.consoles).toHaveLength(1)
    expect(again.history).toEqual(['[sub0-0] test-soc login:'])
    again.close()
    clock += 60_000
    expect(svc.consoles.reap().watching).toEqual([])
    await svc.consoles.open('lab1-sub0-0')
    expect(lab.consoles).toHaveLength(2)
  })

  it('keeps a board that is being flashed busy until the flash ends, even once its lock is stolen', async () => {
    let finish!: () => void
    class FlashLab extends FakeLab {
      builds = { boot: () => new Promise<string>(resolve => { finish = () => resolve('flashed') }) }
    }
    const lab = new FlashLab()
    lab.listed = lab.listed.map(device => ({ ...device, sdks: ['sdk-a'] }))
    const { svc } = labService(lab)
    await enable(svc)
    const board = 'lab1-sub0-0'
    const { token } = await svc.locks.lock(board, 'claude:s1', '刷机')
    const flashing = call(svc, '/api/boot/sdk', 'claude:s1', { board, token, sdk: 'sdk-a', method: 'download' })
    await new Promise(resolve => setTimeout(resolve, 5))
    const stolen = svc.locks.steal(board, 'user:bob', '要用')
    expect(stolen.lease?.purpose).toBe('抢锁：要用')
    expect(svc.boards.get(board).busy).toMatchObject({ kind: 'boot', label: '刷机中', by: 'claude:s1' })
    await expect(call(svc, '/api/reset', 'user:bob', { board, token: stolen.token })).rejects.toThrow(/正在刷机/)
    finish(); await flashing.catch(() => {})
    expect(svc.boards.get(board).busy).toBeNull()
  })

  it('boots or flashes a lab board with an SDK, the lab fetching the build, under the lock', async () => {
    class SdkLab extends FakeLab {
      boots: unknown[] = []
      async bootSdk(_config: LabConfig, device: string, sdk: { sdk: string, method: string, variant: string | null }, lease: string | null, progress: (line: string) => void) {
        progress('[   0.0s] boot k3-a with sdk-a [load]: 10 steps')
        this.boots.push({ device, ...sdk, lease })
        return 'job boot-7 succeeded in 41s'
      }
      builds = { boot: (config: LabConfig, target: BoardTarget, build: { sdk: string, method: string, variant: string | null }, progress: (line: string) => void) => this.bootSdk(config, target.device, build, target.lease, progress) }
    }
    const lab = new SdkLab()
    lab.listed = lab.listed.map(device => ({ ...device, sdks: ['sdk-a'] }))
    const { svc } = labService(lab)
    await enable(svc)
    expect(svc.boards.get('lab1-sub0-0').lab?.sdks).toEqual(['sdk-a'])
    await expect(svc.download.build('lab1-sub0-0', { holder: 'claude:s1' }, { sdk: 'sdk-a' })).rejects.toThrow(/请先拿/)
    const { token } = await svc.locks.lock('lab1-sub0-0', 'claude:s1', '启动')
    const claude = { holder: 'claude:s1', token }
    await expect(svc.download.build('lab1-sub0-0', claude, { sdk: 'other' })).rejects.toThrow(/不能跑 SDK other/)
    const seen: Array<string | null> = []
    svc.events.on('event', () => seen.push(svc.boards.get('lab1-sub0-0').lab!.progress))
    expect(await svc.download.build('lab1-sub0-0', claude, { sdk: 'sdk-a', method: 'download' })).toBe('job boot-7 succeeded in 41s')
    expect(lab.boots).toEqual([{ device: 'sub0-0', sdk: 'sdk-a', method: 'download', variant: null, brk: null, lease: null }])
    expect(seen).toContain('boot k3-a with sdk-a [load]: 10 steps')
    expect(svc.boards.get('lab1-sub0-0').lab?.progress).toBeNull()
    expect(svc.boards.detail('lab1-sub0-0').actions[0]).toMatchObject({ kind: 'flash', detail: 'sdk-a 刷机', ok: true })
    await expect(svc.download.build('com260', { holder: 'user:alice' }, { sdk: 'sdk-a' })).rejects.toThrow()
  })

  it('flashes a lab board with a package from a link or a file sent to boardd, busy until it ends, under the lock', async () => {
    class PackageLab extends FakeLab {
      flashed: unknown[] = []
      finish: Array<() => void> = []
      /** Flashes end at once, for the CLI. */
      quick = false
      builds = {
        boot: async () => '',
        flash: (_config: LabConfig, target: BoardTarget, pkg: unknown, progress: (line: string) => void, signal?: AbortSignal) => new Promise<string>(resolve => {
          this.flashed.push({ device: target.device, pkg, signal: !!signal })
          progress('[  12.0s] flash rootfs 40%')
          if (this.quick) resolve('job flash-4 succeeded')
          else this.finish.push(() => resolve('job flash-3 succeeded'))
        }),
      }
    }
    const lab = new PackageLab()
    const { svc } = labService(lab)
    await enable(svc)
    const board = 'lab1-sub0-0'
    expect(svc.boards.get(board).lab?.canFlashPackage).toBe(true)
    expect(svc.boards.get('com260').lab).toBeNull()
    const url = 'https://images.example/k3/pkg.zip?token=secret'
    await expect(call(svc, '/api/flash/package', 'claude:s1', { board, url })).rejects.toThrow(/请先拿/)
    const { token } = await svc.locks.lock(board, 'claude:s1', '刷机')
    const claude = { holder: 'claude:s1', token }
    for (const [input, refused] of [
      [{}, /链接（http、https）或传上来的文件/], [{ url, sha256: 'x' }, /sha256 不对/], [{ url: 'ftp://images.example/pkg.zip' }, /http:\/\/ 或 https:\/\//],
      [{ url: 'not a link' }, /链接不对/], [{ url: 'http://me:pw@images.example/pkg.zip' }, /账号密码/], [{ url, flasher: 'x; reboot' }, /刷机工具名不合法/],
      [{ sha256: sha('never sent') }, /先传上来/],
    ] as const) await expect(svc.download.flashPackage(board, claude, input)).rejects.toThrow(refused)
    expect(lab.flashed).toEqual([])

    // A link: the backend downloads it; the board shows it is being flashed, with the progress, until it ends.
    const flashing = call(svc, '/api/flash/package', 'claude:s1', { board, token, url, flasher: 'tool-a' })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(lab.flashed).toEqual([{ device: 'sub0-0', pkg: { url, flasher: 'tool-a' }, signal: true }])
    expect(svc.boards.get(board).busy).toMatchObject({ kind: 'boot', label: '刷机中', by: 'claude:s1', line: 'flash rootfs 40%' })
    expect(svc.boards.get(board).lab?.progress).toBe('flash rootfs 40%')
    await expect(call(svc, '/api/reset', 'claude:s1', { board, token })).rejects.toThrow(/正在刷机/)
    lab.finish[0]!()
    expect(await flashing).toEqual({ output: 'job flash-3 succeeded' })
    expect(svc.boards.get(board).busy).toBeNull()
    expect(svc.boards.get(board).lab?.progress).toBeNull()
    expect(svc.boards.detail(board).actions[0]).toMatchObject({ kind: 'flash', detail: '刷机包 https://images.example/k3/pkg.zip（tool-a）', ok: true })

    // A file sent to boardd: the backend gets its path here and its sha256.
    const content = 'flash package'
    await svc.files.put('claude:s1', sha(content), 'pkg.zip', (async function* () { yield Buffer.from(content) })(), { total: content.length })
    const sent = call(svc, '/api/flash/package', 'claude:s1', { board, token, sha256: `sha256:${sha(content)}` })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(lab.flashed[1]).toEqual({ device: 'sub0-0', pkg: { path: svc.files.get(sha(content))!.path, sha256: sha(content), flasher: null }, signal: true })
    lab.finish[1]!()
    await sent
    expect(svc.boards.detail(board).actions[0]).toMatchObject({ kind: 'flash', detail: `刷机包 pkg.zip ${sha(content).slice(0, 12)}`, ok: true })

    // The CLI sends a file here first and hands a link on as it is.
    svc.locks.steal(board, 'user:alice', '换我来刷')
    const running = await serve(svc, { port: 47000 + Math.floor(Math.random() * 1000), socketPath: join(dir, 'boardd.sock'), uiDir: null })
    const file = join(dir, 'other-pkg.zip')
    writeFileSync(file, 'another package')
    const quiet = { log: console.log, error: console.error }
    console.log = () => {}; console.error = () => {}
    try {
      lab.quick = true
      await main(['flash', board, file, '--flasher', 'tool-b', '--state-dir', dir, '--as', 'user:alice'])
      await main(['flash', board, url, '--state-dir', dir, '--as', 'user:alice'])
    } finally { Object.assign(console, quiet); await running.close() }
    expect(lab.flashed.slice(2).map(item => (item as { pkg: unknown }).pkg)).toEqual([
      { path: svc.files.get(sha('another package'))!.path, sha256: sha('another package'), flasher: 'tool-b' }, { url, flasher: null },
    ])
    // A backend saying which packages it takes: its own schemes (a user name allowed), a sha256 with the link, its own endings.
    expect(svc.boards.get(board).lab?.packages).toEqual({ schemes: ['http', 'https'], suffixes: [] })
    lab.builds = { ...lab.builds, accepts: { schemes: ['https', 'copy'], suffixes: ['.zip', '.tar.gz'] } } as typeof lab.builds
    expect(svc.boards.get(board).lab?.packages).toEqual({ schemes: ['https', 'copy'], suffixes: ['.zip', '.tar.gz'] })
    const alice = { holder: 'user:alice' }
    const copy = 'copy://builder@build-1/out/pkg.tar.gz'
    expect(await svc.download.flashPackage(board, alice, { url: copy, sha256: sha('x') })).toBe('job flash-4 succeeded')
    expect((lab.flashed.at(-1) as { pkg: unknown }).pkg).toEqual({ url: copy, flasher: null, sha256: sha('x') })
    await expect(svc.download.flashPackage(board, alice, { url: 'http://images.example/pkg.zip' })).rejects.toThrow(/https:\/\/ 或 copy:\/\//)
    await expect(svc.download.flashPackage(board, alice, { url: 'https://images.example/pkg.iso' })).rejects.toThrow(/刷不了这种包.*\.zip、\.tar\.gz/)
    await expect(svc.download.flashPackage(board, alice, { url: 'copy://builder:pw@build-1/out/pkg.zip' })).rejects.toThrow(/账号密码/)
    // A backend that cannot flash packages says so.
    await svc.locks.lock('com260', 'user:alice', '刷机')
    await expect(svc.download.flashPackage('com260', { holder: 'user:alice' }, { url })).rejects.toThrow(/不能用刷机包刷机/)
  })

  it('flashes an image of a market by its place there, onto the boards whose backend takes it and whose SoC it is', async () => {
    class MarketLab extends FakeLab {
      flashed: unknown[] = []
      builds = {
        boot: async () => '',
        accepts: { schemes: ['https'], suffixes: ['.zip'] },
        flash: async (_config: LabConfig, target: BoardTarget, pkg: unknown) => { this.flashed.push({ device: target.device, pkg }); return 'written' },
      }
    }
    const lab = new MarketLab()
    const { svc } = labService(lab)
    await enable(svc)
    const image = (path: string, soc: string) => ({ path, name: path.split('/').at(-1)!, kind: 'image' as const, soc, sha256: sha(path) })
    svc.markets.offer({
      kind: 'shelf', title: '书架', about: '', create: () => ({
        list: async () => [image('test-soc/a.zip', 'test-soc'), image('test-soc/a.iso', 'test-soc'), image('other-soc/b.zip', 'other-soc')],
        locate: async path => ({ url: `https://images.example/${path}`, name: path.split('/').at(-1)!, sha256: sha(path) }),
      }),
    })
    svc.markets.configure('shelf', { kind: 'shelf', config: {}, source: 'test' })
    await svc.locks.lock('lab1-sub0-1', 'user:bob', '在用')
    const { token } = await svc.locks.lock('lab1-sub0-0', 'claude:s1', '刷机')

    // Boards that take the image, the caller's first, then free ones, then the rest with why; another SoC's image goes nowhere.
    expect(await svc.markets.targets('shelf', 'test-soc/a.zip', 'claude:s1', svc.boards.list())).toEqual([
      { board: 'lab1-sub0-0', soc: 'test-soc', mine: true, free: false, why: null },
      { board: 'lab1-sub0-1', soc: 'test-soc', mine: false, free: false, why: 'user:bob 在用' },
    ])
    await svc.locks.unlock('lab1-sub0-1', { holder: 'user:bob' })
    expect((await svc.markets.targets('shelf', 'test-soc/a.zip', 'claude:s1', svc.boards.list()))[1]).toEqual({ board: 'lab1-sub0-1', soc: 'test-soc', mine: false, free: true, why: null })
    expect(await svc.markets.targets('shelf', 'test-soc/a.iso', 'claude:s1', svc.boards.list())).toEqual([])
    expect(await svc.markets.targets('shelf', 'other-soc/b.zip', 'claude:s1', svc.boards.list())).toEqual([])

    // A flash by the image's place: the backend gets the market's link and the sha256 it must hash to.
    expect(await call(svc, '/api/flash/package', 'claude:s1', { board: 'lab1-sub0-0', token, image: { market: 'shelf', path: 'test-soc/a.zip' } })).toEqual({ output: 'written' })
    expect(lab.flashed).toEqual([{ device: 'sub0-0', pkg: { url: 'https://images.example/test-soc/a.zip', flasher: null, sha256: sha('test-soc/a.zip') } }])
    await expect(call(svc, '/api/flash/package', 'claude:s1', { board: 'lab1-sub0-0', token, image: { market: 'shelf', path: 'test-soc/a.zip' }, url: 'https://x.example/p.zip' })).rejects.toThrow(/三选一/)
    await expect(call(svc, '/api/flash/package', 'claude:s1', { board: 'lab1-sub0-0', token, image: { market: 'shelf', path: 'test-soc/a.iso' } })).rejects.toThrow(/刷不了这种包/)

    // The CLI lists the markets and a folder, says where an image could go, and flashes one by its place.
    svc.locks.steal('lab1-sub0-0', 'user:alice', '换我来刷')
    const running = await serve(svc, { port: 0, socketPath: join(dir, 'boardd.sock'), uiDir: null })
    const lines: string[] = []
    const quiet = { log: console.log, error: console.error }
    console.log = (line: string) => lines.push(line); console.error = () => {}
    const cli = (...args: string[]) => main([...args, '--state-dir', dir, '--as', 'user:alice'])
    try {
      await cli('images')
      await cli('images', 'shelf', '--soc', 'test-soc')
      await cli('images', 'shelf:test-soc/a.zip', '--targets')
      await cli('flash', 'lab1-sub0-0', '--image', 'shelf:test-soc/a.zip')
      await expect(cli('flash', 'lab1-sub0-0', '--image', 'test-soc/a.zip')).rejects.toThrow(/<市场>:<路径>/)
      await expect(cli('flash', 'lab1-sub0-0', 'https://x.example/p.zip', '--image', 'shelf:test-soc/a.zip')).rejects.toThrow(/用法/)
    } finally { Object.assign(console, quiet); await running.close() }
    expect(lines[0]).toMatch(/^shelf +shelf（书架，test 设的）$/)
    expect(lines.filter(line => line.includes('\n    shelf:')).map(line => line.split('\n')[1]!.trim())).toEqual(['shelf:test-soc/a.zip', 'shelf:test-soc/a.iso'])
    expect(lines.some(line => /lab1-sub0-0 +test-soc +你拿着/.test(line))).toBe(true)
    expect(lab.flashed.at(-1)).toEqual({ device: 'sub0-0', pkg: { url: 'https://images.example/test-soc/a.zip', flasher: null, sha256: sha('test-soc/a.zip') } })
  })

  it('shows what a package would write, flashes chosen partitions, and resets after when asked', async () => {
    const plan = {
      package: 'pkg.zip', partial: true, notes: ['the layout is chosen once the board is seen'],
      media: [{ id: 'table-a', label: 'disk · 8 MiB', size: 8 << 20, partitions: [
        { name: 'boot', offset: 0, size: 1 << 20, image: 'boot.img', payload: 4096, selectable: true },
        { name: 'root', offset: 1 << 20, size: null, image: null, payload: null, selectable: false },
      ] }],
    }
    class PlanLab extends FakeLab {
      flashed: unknown[] = []
      planned: unknown[] = []
      builds = {
        boot: async () => '',
        flash: async (_config: LabConfig, target: BoardTarget, pkg: unknown) => { this.flashed.push({ device: target.device, pkg }); return 'written' },
        plan: async (_config: LabConfig, target: BoardTarget, pkg: unknown, progress: (line: string) => void) => { this.planned.push({ device: target.device, pkg }); progress('fetching pkg.zip 50%'); return plan },
      }
    }
    const lab = new PlanLab()
    const { svc } = labService(lab)
    await enable(svc)
    const board = 'lab1-sub0-0', url = 'https://images.example/pkg.zip'
    await expect(svc.download.plan(board, { holder: 'claude:s1' }, { url })).rejects.toThrow(/请先拿/)
    const { token } = await svc.locks.lock(board, 'claude:s1', '刷机')
    const claude = { holder: 'claude:s1', token }

    // The plan streams the backend's progress and ends with what it read; the board is not marked busy.
    const running = await serve(svc, { port: 0, socketPath: join(dir, 'boardd.sock'), uiDir: null })
    try {
      const lines: string[] = []
      expect(await new BoardsClient(join(dir, 'boardd.sock')).flashPlan(board, { url }, text => lines.push(text), token)).toEqual(plan)
      expect(lines).toEqual(['fetching pkg.zip 50%\n'])
      expect(lab.planned).toEqual([{ device: 'sub0-0', pkg: { url, flasher: null } }])
      expect(svc.boards.get(board).busy).toBeNull()
      await expect(new BoardsClient(join(dir, 'boardd.sock')).flashPlan(board, { url: 'ftp://x.example/p.zip' }, () => {}, token)).rejects.toThrow(/http:\/\/ 或 https:\/\//)
    } catch (error) { await running.close(); throw error }

    // Chosen partitions go to the backend, and a reset follows a flash that asked for one.
    expect(await svc.download.flashPackage(board, claude, { url, partitions: ['boot'], reset: true })).toBe('written\n已复位 lab1-sub0-0')
    expect(lab.flashed).toEqual([{ device: 'sub0-0', pkg: { url, flasher: null, partitions: ['boot'] } }])
    expect(lab.calls.at(-1)).toBe('reset sub0-0')
    expect(svc.boards.detail(board).actions.map(a => a.kind).slice(0, 2)).toEqual(['reset', 'flash'])
    expect(svc.boards.detail(board).actions[1]).toMatchObject({ detail: '刷机包 https://images.example/pkg.zip，只刷 boot' })
    await expect(svc.download.flashPackage(board, claude, { url, partitions: ['boot; rm'] })).rejects.toThrow(/分区名不合法/)
    // The backend says it can plan, so the page offers it.
    expect(svc.boards.get(board).lab?.canPlan).toBe(true)
    // A lock given back while the flash runs refuses the reset, but the flash is written and said so.
    const flash = lab.builds.flash
    lab.builds.flash = async () => { svc.locks.unlock(board, claude); return 'written' }
    expect(await svc.download.flashPackage(board, claude, { url, reset: true })).toMatch(/^written\n刷好了，但没有复位：/)
    expect(svc.boards.detail(board).actions[0]).toMatchObject({ kind: 'flash', ok: true })
    lab.builds.flash = flash
    claude.token = (await svc.locks.lock(board, 'claude:s1', '刷机')).token

    // The CLI prints a plan as a table, and passes chosen partitions and a reset on.
    svc.locks.steal(board, 'user:alice', '换我来刷')
    const printed: string[] = []
    const log = console.log
    console.log = (line: string) => printed.push(line)
    try {
      await main(['flash', board, url, '--plan', '--state-dir', dir, '--as', 'user:alice'])
      await main(['flash', board, url, '--partitions', 'boot', '--reset', '--state-dir', dir, '--as', 'user:alice'])
    } finally { console.log = log; await running.close() }
    expect(printed.join('\n')).toMatch(/pkg\.zip（可以只刷其中几个分区：--partitions）\n\ndisk · 8 MiB  8 MiB\n  · boot +@0 B +1 MiB +boot\.img（4 KiB）\n    root +@1 MiB +— +（包里没有，不写）\n\n注意：the layout is chosen once the board is seen/)
    expect(lab.flashed.at(-1)).toEqual({ device: 'sub0-0', pkg: { url, flasher: null, partitions: ['boot'] } })
    expect(lab.calls.at(-1)).toBe('reset sub0-0')
    // A backend that cannot read a package first says so.
    lab.builds = { ...lab.builds, plan: undefined } as unknown as typeof lab.builds
    await expect(svc.download.plan(board, { holder: 'user:alice' }, { url })).rejects.toThrow(/不能先看刷机包里有什么/)
  })

  it('works a lab board\'s relays and buttons one by one, under its lock', async () => {
    class RelayLab extends FakeLab {
      switched: string[] = []
      channels = {
        list: async (_config: LabConfig, target: BoardTarget) => [{ id: `${target.device}/power`, label: 'power', kind: 'relay', state: 'on', actions: ['on', 'off', 'pulse'] as Array<'on' | 'off' | 'pulse'> }],
        set: async (_config: LabConfig, target: BoardTarget, channel: string, action: string, ms: number | null) => { this.switched.push(`${target.device} ${channel} ${action} ${ms}`); return `${channel} ${action}` },
      }
    }
    const lab = new RelayLab()
    const { svc } = labService(lab)
    await enable(svc)
    expect(await svc.relay.channels('lab1-sub0-0')).toEqual({ board: 'lab1-sub0-0', supported: true, channels: [{ id: 'sub0-0/power', label: 'power', kind: 'relay', state: 'on', actions: ['on', 'off', 'pulse'] }] })
    await expect(svc.relay.setChannel('lab1-sub0-0', { holder: 'claude:s1' }, { channel: 'sub0-0/power', action: 'off' })).rejects.toThrow(/请先拿/)
    const { token } = await svc.locks.lock('lab1-sub0-0', 'claude:s1', '断电重启')
    const claude = { holder: 'claude:s1', token }
    expect(await svc.relay.setChannel('lab1-sub0-0', claude, { channel: 'sub0-0/power', action: 'pulse', ms: 3000 })).toBe('sub0-0/power pulse')
    expect(lab.switched).toEqual(['sub0-0 sub0-0/power pulse 3000'])
    expect(svc.boards.detail('lab1-sub0-0').actions[0]).toMatchObject({ kind: 'relay', detail: 'sub0-0/power pulse 3000ms', ok: true })
    await expect(svc.relay.setChannel('lab1-sub0-0', claude, { channel: 'sub0-0/power', action: 'explode' as 'on' })).rejects.toThrow(/不认识的动作/)
    await expect(svc.relay.setChannel('lab1-sub0-0', claude, { channel: 'x; reboot', action: 'on' })).rejects.toThrow(/通道名不合法/)
    // Boards on a backend without channels have none to show.
    expect(await svc.relay.channels('com260')).toEqual({ board: 'com260', supported: false, channels: [] })
    // The CLI names a channel by its role, after the board as its backend knows it.
    const running = await serve(svc, { port: 46000 + Math.floor(Math.random() * 1000), socketPath: join(dir, 'boardd.sock'), uiDir: null })
    const lines: string[] = []
    const log = console.log
    console.log = (line: string) => lines.push(line)
    try {
      await main(['relay', 'lab1-sub0-0', '--state-dir', dir, '--as', 'user:alice'])
      await svc.locks.steal('lab1-sub0-0', 'user:alice', '换我来')
      await main(['relay', 'lab1-sub0-0', 'power', 'off', '--state-dir', dir, '--as', 'user:alice'])
    } finally { console.log = log; await running.close() }
    expect(lines[0]).toMatch(/^sub0-0\/power +relay +on +on off pulse$/)
    expect(lab.switched.at(-1)).toBe('sub0-0 sub0-0/power off null')
  })

  it('rebuilds a re-cabled host, never while one of its boards is held, and greys boards whose slot is gone', async () => {
    class RebuildLab extends FakeLab {
      constructor() {
        super()
        this.listed = [
          { name: 'k3-a', slot: 'h1/s1', model: 'k3', online: true, serialPort: 'h1:s1', serialConnected: false, slotGone: true, downloadUsbPath: null, ip: null },
          { name: 'k1-b', slot: 'h2/s1', model: 'k1', online: true, serialPort: 'h2:s1', serialConnected: true, downloadUsbPath: null, ip: null },
        ]
      }
      discovery = {
        methods: async () => [{ id: 'gpio', title: '发现', about: '逐个拉复位线' }],
        run: async () => ({ message: '', found: [] }),
        register: async () => {},
        rebuild: async (_config: LabConfig, host: string, _progress: (line: string) => void, registered?: (device: string) => void) => {
          this.calls.push(`rebuild ${host}`)
          this.listed[0] = { name: 'k3-a', slot: 'h1/s1', model: 'k3', online: true, serialPort: 'h1:s1', serialConnected: true, downloadUsbPath: '1-2.1', ip: null }
          registered?.('k3-a')
          return { message: '登记了 1 块：h1/k3-a', found: [] }
        },
      }
    }
    const lab = new RebuildLab()
    const { svc } = labService(lab)
    await enable(svc, { devices: '' })
    expect(svc.backends.labSettings()[0]).toMatchObject({ canDiscover: true, canRebuild: true })
    expect(svc.boards.get('lab1-k3-a').lab).toMatchObject({ slotGone: true })
    await expect(svc.backends.rebuild('user:alice', 'lab1', true, '')).rejects.toThrow(/主机名不合法/)
    await expect(svc.backends.rebuild('user:alice', 'lab1', false, 'h1')).rejects.toThrow(/需要用户确认/)
    // A board held on the host stops the rebuild; one held on another host does not.
    await svc.locks.lock('lab1-k3-a', 'user:bob', '调试')
    await expect(svc.backends.rebuild('user:alice', 'lab1', true, 'h1')).rejects.toThrow(/lab1-k3-a 正被 user:bob 使用/)
    await svc.locks.unlock('lab1-k3-a', { holder: 'user:bob' })
    await svc.locks.lock('lab1-k1-b', 'user:bob', '调试')
    const result = await svc.backends.rebuild('user:alice', 'lab1', true, 'h1')
    expect(result.message).toBe('登记了 1 块：h1/k3-a')
    expect(lab.calls.at(-1)).toBe('rebuild h1')
    expect(svc.boards.get('lab1-k3-a').lab).toMatchObject({ slotGone: false })          // listed again after the rebuild
    expect(svc.history().actions.find(action => action.kind === 'lab-rebuild')).toMatchObject({ detail: 'lab1 重建 h1', ok: true })
  })

  it('rediscovers a host while its boards are held, when the backend keeps the boards in use', async () => {
    const seen: unknown[] = []
    class KeepLab extends FakeLab {
      constructor() { super(); this.listed = [{ name: 'k3-a', slot: 'h1/s1', model: 'k3', online: true, serialPort: 'h1:s1', serialConnected: true, downloadUsbPath: null, ip: null }] }
      discovery = {
        methods: async () => [{ id: 'gpio', title: '发现', about: '逐个拉复位线' }], run: async () => ({ message: '', found: [] }), register: async () => {}, keepsInUse: true,
        rebuild: async (_config: LabConfig, host: string, _progress: (line: string) => void, _registered?: (device: string) => void, options?: { keepInUse: boolean }) => { seen.push([host, options]); return { message: '没有变动', found: [] } },
      }
    }
    const lab = new KeepLab()
    const { svc } = labService(lab)
    await enable(svc, { devices: '' })
    expect(svc.backends.labSettings()[0]).toMatchObject({ canRebuild: true, canRediscover: true })
    await svc.locks.lock('lab1-k3-a', 'user:bob', '调试')
    await expect(svc.backends.rebuild('user:alice', 'lab1', true, 'h1')).rejects.toThrow(/正被 user:bob 使用/)   // a whole rebuild still waits
    expect((await svc.backends.rebuild('user:alice', 'lab1', true, 'h1', true)).message).toBe('没有变动')
    expect(seen).toEqual([['h1', { keepInUse: true }]])
    expect(svc.history().actions.find(action => action.kind === 'lab-rebuild')).toMatchObject({ detail: 'lab1 重新发现 h1', ok: true })
  })

  it('reads again once when the connection drops before an answer, and never writes twice', async () => {
    let seen = 0
    const server = createHttpServer((req, res) => { if (seen++ === 0) { req.socket.destroy(); return } res.setHeader('content-type', 'application/json'); res.end('{"ok":true}') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const client = new BoardsClient({ label: 'test', kind: 'web', request: (method, path, headers) => request({ host: '127.0.0.1', port, method, path, headers }) })
    try {
      expect(await client.call('GET', '/api/state')).toEqual({ ok: true })
      expect(seen).toBe(2)
      seen = 0
      await expect(client.call('POST', '/api/lock', {})).rejects.toThrow(/socket hang up/)
      expect(seen).toBe(1)
    } finally { server.close() }
  })

  it('says why ssh could not connect, not only that the socket hung up', async () => {
    const bin = join(dir, 'fakebin'); mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'ssh'), '#!/bin/sh\necho "Permission denied (publickey)." >&2\nexit 255\n')
    chmodSync(join(bin, 'ssh'), 0o755)
    const was = process.env.PATH
    process.env.PATH = `${bin}:${was}`
    try {
      const client = new BoardsClient(sshTransport('ssh://boardlab@boardd.example', { controlDir: join(dir, 'ssh') }))
      await expect(client.call('GET', '/api/state')).rejects.toThrow(/Permission denied/)
      await expect(client.call('GET', '/api/state')).rejects.not.toThrow(/socket hang up/)
    } finally { process.env.PATH = was }
  })

  it('shows a slot as being discovered while it is, and starts nothing else on it meanwhile', async () => {
    let finish!: () => void, progress!: (line: string) => void
    class SlotLab extends FakeLab {
      constructor() {
        super()
        this.listed = [
          { name: 'k3-a', slot: 'h1/s1', model: 'k3', online: true, serialPort: 'h1:s1', serialConnected: true, downloadUsbPath: null, ip: null },
          { name: 'h1-s2', slot: 'h1/s2', empty: true, model: null, online: false, serialPort: 'h1:s2', serialConnected: true, downloadUsbPath: null, ip: null },
        ]
      }
      discovery = {
        methods: async () => [{ id: 'gpio', title: '发现', about: '逐个拉复位线', fields: [] }],
        run: (_config: LabConfig, _method: string, _values: unknown, _context: unknown, report: (line: string) => void) => { progress = report; return new Promise<{ message: string, found: [] }>(resolve => { finish = () => resolve({ message: '没找到', found: [] }) }) },
        register: async () => {},
      }
    }
    const { svc } = labService(new SlotLab())
    await enable(svc, { devices: '' })
    const running = svc.backends.discover('user:alice', 'lab1', true, { method: 'gpio', slot: 'h1/s2' })
    await new Promise(resolve => setImmediate(resolve))
    expect(svc.boards.get('lab1-h1-s2').busy).toMatchObject({ kind: 'discover', label: '发现', by: 'user:alice' })
    expect(svc.boards.get('lab1-k3-a').busy).toBeNull()                    // only the slot asked for
    progress('round 1: pulsing P13')
    expect(svc.boards.get('lab1-h1-s2').busy?.line).toBe('round 1: pulsing P13')
    await expect(svc.kernel.doing(['lab1-h1-s2'], 'reset', '复位中', 'user:bob', async () => {})).rejects.toThrow(/lab1-h1-s2 正在发现（user:alice/)
    finish()
    await running
    expect(svc.boards.get('lab1-h1-s2').busy).toBeNull()
    // A lab itself can be busy too (its module installing it), shown in its settings.
    let done!: () => void
    const installing = svc.kernel.doing(['lab:lab1'], 'install', '安装中', 'user:alice', () => new Promise<void>(resolve => { done = resolve }))
    expect(svc.backends.labSettings()[0]!.busy).toMatchObject({ label: '安装中' })
    done(); await installing
    expect(svc.backends.labSettings()[0]!.busy).toBeNull()
  })

  it('tells a search that never started, its slot busy, from one that failed on a conflict of its own', async () => {
    let fail: Error | null = null
    class SlotLab extends FakeLab {
      constructor() { super(); this.listed = [{ name: 'h1-s2', slot: 'h1/s2', empty: true, model: null, online: false, serialPort: 'h1:s2', serialConnected: true, downloadUsbPath: null, ip: null }] }
      discovery = {
        methods: async () => [{ id: 'gpio', title: '发现', about: '逐个拉复位线', fields: [] }],
        run: async () => { if (fail) throw fail; return { message: '没找到', found: [] } },
        register: async () => {},
      }
    }
    const { svc } = labService(new SlotLab())
    await enable(svc, { devices: '' })
    const discovery = () => svc.backends.labSettings()[0]!.discovery
    let done!: () => void
    const resetting = svc.kernel.doing(['lab1-h1-s2'], 'reset', '复位中', 'user:bob', () => new Promise<void>(resolve => { done = resolve }))
    await expect(svc.backends.discover('user:alice', 'lab1', true, { method: 'gpio', slot: 'h1/s2' })).rejects.toThrow(/正在复位/)
    expect(discovery()?.line).toMatch(/^没开始：/)
    done(); await resetting
    expect(svc.history().actions.some(action => action.kind === 'lab-discover')).toBe(false)
    // The backend's own conflict, mid-search, is a failure, and recorded.
    fail = new BoardError('conflict', 'the host is probing already')
    await expect(svc.backends.discover('user:alice', 'lab1', true, { method: 'gpio', slot: 'h1/s2' })).rejects.toThrow(/probing already/)
    expect(discovery()?.line).toBe('失败：the host is probing already')
    expect(svc.history().actions.find(action => action.kind === 'lab-discover')).toMatchObject({ ok: false, message: 'the host is probing already' })
  })

  it('refuses to rediscover with a backend that can only rebuild a whole host', async () => {
    class WholeLab extends FakeLab { discovery = { methods: async () => [{ id: 'gpio', title: '发现', about: '逐个拉复位线' }], run: async () => ({ message: '', found: [] }), register: async () => {}, rebuild: async () => ({ message: '', found: [] }) } }
    const { svc } = labService(new WholeLab())
    await enable(svc, { devices: '' })
    expect(svc.backends.labSettings()[0]).toMatchObject({ canRebuild: true, canRediscover: false })
    await expect(svc.backends.rebuild('user:alice', 'lab1', true, 'h1', true)).rejects.toThrow(/只能整台重建/)
  })

  it('finds new boards while others are held, by reset lines or by a person pairing them', async () => {
    const lab = new FakeLab()
    const asked: unknown[] = []
    ;(lab as unknown as { discovery: unknown }).discovery = {
      methods: async () => [{ id: 'gpio', title: '按复位线', about: '逐个拉复位线' }, { id: 'human', title: '人工发现', about: '按提示让板子进下载模式' }],
      run: async (_config: LabConfig, method: string, _values: unknown, context: unknown) => { asked.push([method, context]); return { message: '配对了 1 块', found: [] } },
      register: async () => {},
    }
    const { svc } = labService(lab)
    await enable(svc)
    await svc.locks.lock('lab1-sub0-0', 'user:bob', '调试')
    // The backend pulses only reset lines no board uses, so a held board does not stop it; the method is its own.
    expect((await svc.backends.discover('user:alice', 'lab1', true, { method: 'gpio' })).message).toBe('配对了 1 块')
    expect((await svc.backends.discover('user:alice', 'lab1', true, { method: 'human', host: 'h1' })).message).toBe('配对了 1 块')
    expect(asked).toEqual([['gpio', { host: null, slot: null }], ['human', { host: 'h1', slot: null }]])
  })

  it('names boards by their slot, keeps a slot\'s lock when its board is registered or swapped, and reads a swapped board again', async () => {
    /** A lab whose boards sit in slots: s1 holds a board, s2 is only a console so far. */
    class SlotLab extends FakeLab {
      refreshed: string[] = []
      constructor() {
        super()
        this.listed = [
          { name: 'k3-deb1', slot: 'h1/s1', model: 'k3', online: true, serialPort: 'h1:s1', serialConnected: true, downloadUsbPath: '1-2.1', ip: null },
          { name: 'h1-s2', address: 'h1/s2', slot: 'h1/s2', empty: true, model: null, online: false, serialPort: 'h1:s2', serialConnected: true, downloadUsbPath: null, ip: null },
        ]
        this.inventory.refresh = async (_config, target, options) => {
          this.refreshed.push(`${target.device} ${target.lease ?? '-'} ${options.name ?? ''}`)
          this.listed[0] = { ...this.listed[0]!, name: options.name ?? target.device, model: 'k3' }
          return { device: options.name ?? target.device, message: '读到 k3_com260' }
        }
      }
      discovery = {
        methods: async () => [{ id: 'gpio', title: '发现', about: '按槽位发现' }],
        run: async (_config: LabConfig, _method: string, _values: unknown, context: { slot?: string | null }, _progress: (line: string) => void, registered?: (device: string) => void) => {
          this.calls.push(`discover ${context.slot ?? ''}`)
          this.listed[1] = { name: 'k3-new', slot: 'h1/s2', model: 'k3', online: true, serialPort: 'h1:s2', serialConnected: true, downloadUsbPath: '1-2.2', ip: null }
          registered?.('k3-new')
          return { message: '登记了 1 块：h1/k3-new', found: [] }
        },
        register: async () => {},
      }
    }
    const lab = new SlotLab()
    const { svc } = labService(lab)
    await enable(svc, { devices: '' })
    expect(svc.boards.list().filter(board => board.lab).map(board => [board.name, board.slotRef, board.lab!.empty, board.lab!.canRefresh])).toEqual([
      ['lab1-h1-s2', 'lab1/h1/s2', true, false], ['lab1-k3-deb1', 'lab1/h1/s1', false, true],
    ])
    expect(svc.boards.resolve('h1/s1')).toBe('lab1-k3-deb1')
    expect(svc.boards.resolve('lab1/h1/s2')).toBe('lab1-h1-s2')
    expect(() => svc.boards.resolve('h1/s9')).toThrow(/没有槽位 h1\/s9/)
    // Someone watching an empty slot's console holds it; discovering that slot is still allowed, and its board takes
    // over the slot's record and lock.
    const watching = await svc.locks.lock('lab1-h1-s2', 'user:alice', '看串口接线')
    expect(watching.lease).toBeTruthy()
    expect(await svc.backends.discover('user:alice', 'lab1', true, { method: 'gpio', slot: 'h1/s2' })).toMatchObject({ registered: ['k3-new'] })
    expect(lab.calls.at(-1)).toBe('discover h1/s2')
    expect(svc.boards.get('lab1-k3-new')).toMatchObject({ slotRef: 'lab1/h1/s2', lease: { holder: 'user:alice', purpose: '看串口接线' } })
    expect(svc.boards.exists('lab1-h1-s2')).toBe(false)
    // The board in s1 is swapped for another: read it again under the lock, by its slot; the new name keeps the lock.
    const { token } = await svc.locks.lock(svc.boards.resolve('h1/s1'), 'claude:s1', '换板后重新读取')
    await expect(svc.backends.refresh('lab1-k3-deb1', { holder: 'claude:s2' })).rejects.toThrow(/正被 claude:s1 使用/)
    expect(await svc.backends.refresh('lab1-k3-deb1', { holder: 'claude:s1', token }, { name: 'k3-board' })).toEqual({ board: 'lab1-k3-board', message: '读到 k3_com260' })
    expect(lab.refreshed).toEqual(['k3-deb1 - k3-board'])
    expect(svc.boards.get('lab1-k3-board')).toMatchObject({ slotRef: 'lab1/h1/s1', lease: { holder: 'claude:s1' } })
    svc.locks.authorize('lab1-k3-board', { holder: 'claude:s1', token })
    expect(svc.history().actions.find(action => action.kind === 'refresh')).toMatchObject({ board: 'lab1-k3-board', ok: true })
    // The CLI takes a slot wherever a board goes, and keeps the lock's token under the board's name.
    const running = await serve(svc, { port: 47000 + Math.floor(Math.random() * 1000), socketPath: join(dir, 'boardd.sock'), uiDir: null })
    const log = console.log
    console.log = () => {}
    svc.locks.unlock('lab1-k3-new', { holder: 'user:alice' })
    try {
      await main(['lock', 'h1/s2', '--for', '槽位测试', '--state-dir', dir, '--as', 'claude:cli'])
      await expect(main(['lock', 'h1/s2', '--for', 'x', '--state-dir', dir, '--as', 'claude:other'])).rejects.toThrow(/正被 claude:cli/)
      await main(['reset', 'lab1-k3-new', '--state-dir', dir, '--as', 'claude:cli'])
      await main(['unlock', 'lab1/h1/s2', '--state-dir', dir, '--as', 'claude:cli'])
    } finally { console.log = log; await running.close() }
    expect(lab.calls.filter(call => call.startsWith('reset'))).toEqual(['reset k3-new'])
    expect(svc.boards.get('lab1-k3-new').lease).toBeNull()
    // An empty slot has nothing to read yet.
    lab.listed.push({ name: 'h1-s3', address: 'h1/s3', slot: 'h1/s3', empty: true, model: null, online: false, serialPort: 'h1:s3', serialConnected: true, downloadUsbPath: null, ip: null })
    await svc.backends.sync('lab1')
    await svc.locks.lock('lab1-h1-s3', 'user:alice', '看')
    await expect(svc.backends.refresh('lab1-h1-s3', { holder: 'user:alice' })).rejects.toThrow(/空槽位/)
  })

  it('follows a lab\'s news: a cable plugged into a host refreshes its free ports and tells the page', async () => {
    class NewsLab extends FakeLab {
      tell: ((news: { kind: 'ports', host: string, added: string[], removed: string[] }) => void) | null = null
      end: ((reason: string) => void) | null = null
      watches = 0
      asks = 0
      watch(_config: LabConfig, onNews: (news: any) => void, ended: (reason: string) => void) { this.watches++; this.tell = onNews; this.end = ended; return () => { this.tell = null } }
      async slots() { this.asks++; return [{ host: 'lab-9', consoles: [{ id: '/dev/ttyUSB3', label: '/dev/ttyUSB3' }], usb: [] }] }
      news = { watch: this.watch.bind(this) }
      ports = { list: this.slots.bind(this), bind: async () => {} }
    }
    const lab = new NewsLab()
    const { svc } = labService(lab)
    await enable(svc)
    expect(lab.watches).toBe(1)
    const told: unknown[] = []
    svc.events.on('event', event => { if (event.type === 'lab-ports' && event.host) told.push(event) })
    lab.tell!({ kind: 'ports', host: 'lab-9', added: ['/dev/ttyUSB3'], removed: [] })
    await svc.backends.refreshPorts('lab1')
    expect(told).toEqual([{ type: 'lab-ports', lab: 'lab1', host: 'lab-9', added: ['/dev/ttyUSB3'], removed: [] }])
    expect((await svc.backends.ports('lab1')).hosts[0]!.consoles[0]!.id).toBe('/dev/ttyUSB3')
    expect(svc.history().actions.find(action => action.kind === 'lab-ports')?.message).toBe('新接上 /dev/ttyUSB3')
    // A stream that ended is followed again at the next lab sync; a disabled lab is not followed.
    await svc.backends.syncAll()
    expect(lab.watches).toBe(1)
    lab.end!('stream lost')
    await svc.backends.syncAll()
    expect(lab.watches).toBe(2)
    await svc.backends.configure('user:alice', 'lab1', { enabled: false })
    expect(lab.tell).toBeNull()
  })

  it('takes device ranges as names or * patterns', () => {
    const range = deviceFilter('sub0-* sub2-1,sub3.*')
    expect(['sub0-0', 'sub0-1', 'sub2-1', 'sub2-0', 'sub3.x', 'sub3-0', 'sub10-0'].filter(range)).toEqual(['sub0-0', 'sub0-1', 'sub2-1', 'sub3.x'])
    expect(deviceFilter('')('anything')).toBe(true)
    expect(deviceFilter(null)('anything')).toBe(true)
  })
})

/** Call an endpoint as `holder`, the way the HTTP gateway does. */
const call = (svc: BoardLab, path: string, holder: string, body: Record<string, unknown>) =>
  Promise.resolve().then(() => svc.api.match('POST', path)!.endpoint.handle({ body, query: new URLSearchParams(), params: {}, caller: { holder, local: true }, signal: new AbortController().signal, upload: null }))

describe('files copied over scp', () => {
  it('gives a ticket path, checks the copied file, and keeps it by sha256', async () => {
    const svc = service()
    const content = Buffer.alloc(3 << 20, 7)
    const digest = createHash('sha256').update(content).digest('hex')
    const ticket = await call(svc, '/api/files/ticket', 'user:alice', { sha256: digest, name: '../Image.itb' }) as { id: string, path: string }
    expect(ticket.id).toMatch(/^[0-9a-f]{32}$/)
    expect(ticket.path).toMatch(/\.incoming\/[0-9a-f]{32}\/Image\.itb$/)
    writeFileSync(ticket.path, content)
    const stored = await call(svc, '/api/files/adopt', 'user:alice', { id: ticket.id, sha256: digest, name: 'Image.itb' }) as { stored: boolean, size: number }
    expect(stored).toMatchObject({ stored: true, size: content.length })
    expect(svc.files.get(digest)!.path).toMatch(/Image\.itb$/)
    // A file that is not what it says is refused and removed; it never enters the cache.
    const other = await call(svc, '/api/files/ticket', 'user:alice', { sha256: sha('right'), name: 'x.img' }) as { id: string, path: string }
    writeFileSync(other.path, 'wrong')
    await expect(call(svc, '/api/files/adopt', 'user:alice', { id: other.id, sha256: sha('right'), name: 'x.img' })).rejects.toThrow(/对不上/)
    expect(svc.files.get(sha('right'))).toBeNull()
    // A file the client never copied is refused too.
    const missing = await call(svc, '/api/files/ticket', 'user:alice', { sha256: sha('missing'), name: 'y.img' }) as { id: string, path: string }
    await expect(call(svc, '/api/files/adopt', 'user:alice', { id: missing.id, sha256: sha('missing'), name: 'y.img' })).rejects.toThrow(/没有到/)
  })

  it('an ssh client copies with scp, so no large body passes through boardd', async () => {
    const svc = service()
    const port = 45000 + Math.floor(Math.random() * 1000)
    const running = await serve(svc, { port, socketPath: join(dir, 'scp.sock'), uiDir: null })
    const bin = join(dir, 'bin'); mkdirSync(bin)
    // `ssh -W 127.0.0.1:<port>` opens the tunnel locally, as the real ssh would.
    writeFileSync(join(bin, 'ssh'), `#!${process.execPath}\nconst [h, p] = process.argv[process.argv.indexOf('-W') + 1].split(':')\nconst s = require('node:net').connect(Number(p), h)\nprocess.stdin.pipe(s); s.pipe(process.stdout); s.on('close', () => process.exit(0))\n`, { mode: 0o755 })
    // `sftp -b - target` reads `put "LOCAL" "PATH"` and copies into the paths this test serves boardd from.
    writeFileSync(join(bin, 'sftp'), `#!${process.execPath}\nconst fs = require('node:fs')\nlet input = ''\nprocess.stdin.on('data', d => input += d).on('end', () => {\n  const m = /^put "(.*)" "(.*)"$/m.exec(input.trim())\n  if (!m) process.exit(2)\n  fs.copyFileSync(m[1], m[2])\n})\n`, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      const client = new BoardsClient(sshTransport(`ssh://alice@boardd.example?boardd=${port}`, { person: 'alice', controlDir: join(dir, 'ssh') }), 'user:alice')
      const file = join(dir, 'kernel-FIT.itb')
      const content = Buffer.alloc(12 << 20, 3)
      const digest = createHash('sha256').update(content).digest('hex')
      writeFileSync(file, content)
      const ref = await client.sendFile(file)
      expect(ref).toBe(`sha256:${digest}`)
      expect(svc.files.get(digest)!.path).toMatch(/kernel-FIT\.itb$/)
      // The second call does not copy anything: boardd already has that content.
      expect(await client.sendFile(file)).toBe(ref)
    } finally {
      process.env.PATH = path
      await running.close()
    }
  })
})

describe('renaming a board', () => {
  it('renames it everywhere here: the serial alias, the lock, the queue and its history; only its holder or nobody can', async () => {
    class RenamingHere extends Here {
      renamed: Array<{ board: string, die: string, to: string }> = []
      rename: RenameCapability = {
        perChip: true,
        rename: async (_config, target, to) => { this.renamed.push({ board: target.board, die: target.die, to }); return { alias: to } },
      }
    }
    const here = new RenamingHere()
    const { svc } = coreLab({ here })
    const left = await svc.locks.lock('com260', 'claude:s1', '调试')
    await svc.locks.lock('com260', 'user:bob', '排队', { queue: 'join' })
    // While someone holds it, a rename needs their lock (an agent its token, a person being that person).
    await expect(svc.backends.rename('claude:s2', 'com260', 'k3b', { holder: 'claude:s2', token: null })).rejects.toThrow(/正被 claude:s1 使用/)
    const result = await svc.backends.rename('claude:s1', 'com260', 'k3b', { holder: 'claude:s1', token: left.token })
    expect(result).toEqual({ board: 'k3b', message: 'com260 → k3b' })
    expect(here.renamed).toEqual([{ board: 'com260', die: 'die0', to: 'k3b' }])
    expect(() => svc.boards.get('com260')).toThrow(/没有这块板/)
    const board = svc.boards.get('k3b')
    expect(board.lease?.holder).toBe('claude:s1')
    expect(board.waiters.map(waiter => waiter.holder)).toEqual(['user:bob'])
    expect(board.chips[0]!.alias).toBe('k3b')
    // Its history came with it, the rename is in it, and so is the old name it had.
    expect(svc.boards.detail('k3b').actions.map(action => action.kind)).toEqual(expect.arrayContaining(['add', 'rename']))
    expect(svc.boards.detail('k3b').actions.find(action => action.kind === 'rename')?.message).toBe('com260 → k3b')
    // A name that is taken is refused before anything is renamed.
    svc.boards.add('user:alice', { name: 'taken' })
    await expect(svc.backends.rename('claude:s1', 'k3b', 'taken', { holder: 'claude:s1', token: left.token })).rejects.toThrow(/已有板子 taken/)
  })

  it('rolls back the chips it already renamed when one of them fails', async () => {
    class HalfHere extends Here {
      calls: string[] = []
      rename: RenameCapability = {
        perChip: true,
        rename: async (_config, target, to) => {
          this.calls.push(`${target.port}→${to}`)
          if (to === 'bad' && target.die === 'die1') throw new Error('那个串口没了')
          return { alias: to }
        },
      }
    }
    const here = new HalfHere()
    const { svc } = coreLab({ here })
    svc.boards.add('user:alice', { name: 'twin', chips: [{ serialPath: '/dev/a', alias: 'twin' }, { serialPath: '/dev/b', alias: 'twin-die1' }] })
    await expect(svc.backends.rename('user:alice', 'twin', 'bad', { holder: 'user:alice', token: null })).rejects.toThrow(/改名失败：那个串口没了/)
    // The chip renamed before the failure was put back: nothing changed anywhere, and the retry starts from the old name.
    expect(here.calls).toEqual(['twin→bad', 'twin-die1→bad', 'bad→twin'])
    expect(svc.boards.get('twin').chips.map(chip => chip.alias)).toEqual(['twin', 'twin-die1'])
    expect(svc.history().actions[0]).toMatchObject({ kind: 'rename', ok: false })
  })

  it('renames a lab board under the lab\'s prefix, its DUT keeping the lab\'s own name, and says what the lab did', async () => {
    class RenamingLab extends FakeLab {
      renamed: Array<{ device: string, to: string }> = []
      rename: RenameCapability = {
        rename: async (_config, target, to) => {
          this.renamed.push({ device: target.device, to })
          this.listed = this.listed.map(device => device.name === target.device ? { ...device, name: to } : device)
          return { device: to, message: `${target.device} → ${to}（实验室里也改了）` }
        },
      }
    }
    const lab = new RenamingLab()
    const { svc } = labService(lab)
    await enable(svc)
    const held = await svc.locks.lock('lab1-sub0-0', 'claude:s1', '调试')
    const result = await svc.backends.rename('claude:s1', 'lab1-sub0-0', 'k3alpha', { holder: 'claude:s1', token: held.token })
    expect(result).toEqual({ board: 'lab1-k3alpha', message: 'sub0-0 → k3alpha（实验室里也改了）' })
    // The lab is told the device's own name, without boardd's prefix.
    expect(lab.renamed).toEqual([{ device: 'sub0-0', to: 'k3alpha' }])
    const board = svc.boards.get('lab1-k3alpha')
    expect(board.lab?.device).toBe('k3alpha')
    expect(board.lease?.holder).toBe('claude:s1')
    expect(() => svc.boards.get('lab1-sub0-0')).toThrow(/没有这块板/)
    // Written with the prefix it is kept as it is.
    const again = await svc.backends.rename('claude:s1', 'lab1-k3alpha', 'lab1-other', { holder: 'claude:s1', token: held.token })
    expect(again.board).toBe('lab1-other')
    // An empty slot has nothing to rename.
    lab.listed.push({ name: 'sub0-9', model: null, online: true, serialPort: null, serialConnected: false, downloadUsbPath: null, ip: null, slot: 's9', empty: true })
    await svc.backends.sync('lab1')
    await expect(svc.backends.rename('claude:s1', 'lab1-sub0-9', 'x', { holder: 'claude:s1', token: held.token })).rejects.toThrow(/空槽位/)
  })

  it('remembers a model someone typed in, offers it first next time, and lets no listing replace it until it is cleared', async () => {
    const { svc, lab } = labService()
    svc.boards.update('user:alice', 'com260', { product: 'model-a' })
    expect(svc.boards.get('com260').product).toBe('model-a')
    expect(svc.boards.models()).toEqual(['model-a'])
    svc.boards.add('user:alice', { name: 'board-b', product: 'model-b' })
    expect(svc.boards.models()).toContain('model-b')
    // Used again, it is the first offered.
    svc.boards.update('user:alice', 'com260', { product: 'model-a' })
    expect(svc.boards.models()[0]).toBe('model-a')
    await enable(svc)
    // A model typed in for a lab board stays when the lab lists the board again.
    svc.boards.update('user:alice', 'lab1-sub0-0', { product: 'model-custom' })
    await svc.backends.sync('lab1')
    expect(svc.boards.get('lab1-sub0-0').product).toBe('model-custom')
    expect(lab.listed[0]!.model).toBe('board-a')
    // Cleared, it is the lab's own again.
    svc.boards.update('user:alice', 'lab1-sub0-0', { product: null })
    await svc.backends.sync('lab1')
    expect(svc.boards.get('lab1-sub0-0').product).toBe('board-a')
  })
  it('takes SoCs from explicit input or the distribution resolver and preserves existing records', () => {
    const svc = new BoardLab({ db: openDatabase(join(dir, 'soc.sqlite')), socFromProduct: product => product.startsWith('family-') ? 'inferred-soc' : null })
    svc.boards.add('user:alice', { name: 'explicit', product: 'family-board', soc: 'explicit-soc' })
    svc.boards.add('user:alice', { name: 'inferred', product: 'family-board' })
    svc.boards.add('user:alice', { name: 'unknown', product: 'other-board', soc: 'stored-soc' })
    expect(svc.boards.get('explicit').soc).toBe('explicit-soc')
    expect(svc.boards.get('inferred').soc).toBe('inferred-soc')
    svc.boards.update('user:alice', 'unknown', { product: 'renamed-board' })
    expect(svc.boards.get('unknown').soc).toBe('stored-soc')
    svc.boards.update('user:alice', 'unknown', { soc: null })
    expect(svc.boards.get('unknown').soc).toBeNull()
    svc.boards.add('user:alice', { name: 'generic', product: 'generic-board' })
    expect(svc.boards.get('generic').soc).toBeNull()
  })

  it('discovers installed agent skill destinations without owning their content', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    mkdirSync(join(dir, '.config/opencode'), { recursive: true })
    return import('../src/cli/agents.ts').then(({ installedAgentSkills, noAgentsMessage }) => {
      expect(installedAgentSkills(dir).map(item => [item.agent, item.directory])).toEqual([
        ['Claude Code', join(dir, '.claude/skills')], ['opencode', join(dir, '.config/opencode/skill')],
      ])
      expect(installedAgentSkills(join(dir, 'empty'))).toEqual([])
      expect(noAgentsMessage('use a local directory')).toContain('use a local directory')
    })
  })

  it('adds arbitrary module state without making it part of the core contract', () => {
    const lab = new BoardLab({ db: openDatabase(join(dir, 'state.sqlite')) })
    lab.addState(() => ({ moduleSpecific: { ready: true } }))
    expect(lab.state('user:alice')).toMatchObject({ moduleSpecific: { ready: true } })
  })
})

describe('busy boards', () => {
  it('show busy only for whoever may do the operation, so someone refused never holds up the holder', async () => {
    const { svc, here } = coreLab()
    await svc.locks.lock('com260', 'user:alice', '调试')
    const seen: unknown[] = []
    svc.events.on('event', event => { if (event.type === 'changed') seen.push(svc.kernel.busy.get('com260') ?? null) })
    // Bob's reset and Alice's arrive together: his is refused before the board shows busy, hers goes ahead.
    const [bob, alice] = await Promise.allSettled([call(svc, '/api/reset', 'user:bob', { board: 'com260' }), call(svc, '/api/reset', 'user:alice', { board: 'com260' })])
    expect(bob).toMatchObject({ status: 'rejected', reason: { code: 'locked' } })
    expect(alice.status).toBe('fulfilled')
    expect(here.resets).toEqual(['com260'])
    expect(seen.filter(Boolean).every(busy => (busy as { by: string }).by === 'user:alice')).toBe(true)
    // Removing a held board is refused the same way, before it shows as being removed.
    seen.length = 0
    await expect(call(svc, '/api/boards/remove', 'user:bob', { name: 'com260' })).rejects.toMatchObject({ code: 'locked' })
    expect(seen).toEqual([])
  })

  it('last only as long as the lock: once it is stolen the next holder starts at once, and the old run is told to stop', async () => {
    class WaitingLab extends FakeLab {
      waiting: Array<{ signal?: AbortSignal, done: () => void }> = []
      constructor() {
        super()
        // A reset waiting for a person, which goes on until it is let go.
        this.relay.reset = (_config, _target, notice, signal) => new Promise<void>(done => { notice?.('press RESET'); this.waiting.push({ signal, done }) })
      }
    }
    const lab = new WaitingLab()
    const { svc } = labService(lab)
    await enable(svc)
    const board = 'lab1-sub0-0'
    const { token } = await svc.locks.lock(board, 'claude:s1', '调试')
    const first = call(svc, '/api/reset', 'claude:s1', { board, token })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(svc.boards.get(board).busy).toMatchObject({ kind: 'reset', by: 'claude:s1' })
    expect(svc.boards.get(board).lab?.attention).toBe('press RESET')
    const stolen = svc.locks.steal(board, 'user:bob', '要用')
    expect(svc.boards.get(board).busy).toBeNull()
    expect(svc.boards.get(board).lab?.attention).toBeNull()               // nobody is asked for the old reset any more
    expect(lab.waiting[0]!.signal?.aborted).toBe(true)
    const second = call(svc, '/api/reset', 'user:bob', { board, token: stolen.token })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(svc.boards.get(board).busy).toMatchObject({ kind: 'reset', by: 'user:bob' })
    // The old run ending late leaves the new one shown, and what it asks.
    lab.waiting[0]!.done()
    await first
    expect(svc.boards.get(board).busy).toMatchObject({ kind: 'reset', by: 'user:bob' })
    expect(svc.boards.get(board).lab?.attention).toBe('press RESET')
    lab.waiting[1]!.done()
    await second
    expect(svc.boards.get(board).busy).toBeNull()
    // A lock given back frees the board the same way.
    const third = call(svc, '/api/reset', 'user:bob', { board, token: stolen.token })
    await new Promise(resolve => setTimeout(resolve, 5))
    svc.locks.unlock(board, { holder: 'user:bob', token: stolen.token })
    expect(svc.boards.get(board).busy).toBeNull()
    expect(lab.waiting[2]!.signal?.aborted).toBe(true)
    lab.waiting[2]!.done()
    await third
  })
})

const on = (device: string): BoardTarget => ({ board: `lab1-${device}`, device, lease: null, die: 'die0', usbPath: null, port: null, gate: null })

describe('modules', () => {
  it('serve only what they bring: a boardd of remote labs alone has no slots, scans or Home Assistant', async () => {
    const lab = new BoardLab({ db: openDatabase(join(dir, 'labs-only.sqlite')), modules: [{ id: 'test-labs', title: '测试实验室', setup: lab => lab.backends.register('lab1', new FakeLab()) }] })
    const state = lab.state('user:alice')
    expect(state.modules).toEqual([{ id: 'test-labs', title: '测试实验室' }])
    expect(state).not.toHaveProperty('slots')
    expect(state).not.toHaveProperty('ha')
    expect(state.labs.map(item => item.id)).toEqual(['lab1'])
    // A board registered by hand has no backend to reach it through here.
    lab.boards.add('user:alice', { name: 'orphan', chips: [{ alias: 'orphan' }] })
    await lab.locks.lock('orphan', 'user:alice', '试')
    await expect(lab.relay.reset('orphan', { holder: 'user:alice' })).rejects.toThrow(/后端 local 没有装上/)
    const socketPath = join(dir, 'labs-only.sock')
    const running = await serve(lab, { port: 42000 + Math.floor(Math.random() * 1000), socketPath, uiDir: null })
    try {
      const client = new BoardsClient(socketPath, 'claude:s1')
      const index = await client.call<{ endpoints: string[], described: Array<{ path: string, module: string }> }>('GET', '/api')
      expect(index.endpoints).toContain('POST /api/lock')
      expect(index.endpoints).toContain('POST /api/cli')
      expect(index.endpoints).not.toContain('POST /api/scan')
      expect(index.described.find(item => item.path === '/api/labs')?.module).toBe('core')
      await expect(client.call('POST', '/api/scan', { confirmed: true })).rejects.toMatchObject({ status: 404 })
    } finally { await running.close() }
  })

  it('serve the help pages shipped with the distribution, by name only', async () => {
    const lab = new BoardLab({ db: openDatabase(join(dir, 'docs.sqlite')) })
    const docs = join(dir, 'docs'); mkdirSync(docs)
    writeFileSync(join(docs, 'site.md'), '# The site\n\nWhat every host reads.\n'); writeFileSync(join(docs, 'notes.md'), 'no heading\n'); writeFileSync(join(docs, 'Bad.md'), 'x')
    const socketPath = join(dir, 'docs.sock')
    const running = await serve(lab, { port: 43000 + Math.floor(Math.random() * 1000), socketPath, uiDir: null, docsDir: docs })
    try {
      const client = new BoardsClient(socketPath, 'user:alice')
      expect(await client.call('GET', '/api/docs')).toEqual({ docs: [{ name: 'notes', title: 'notes' }, { name: 'site', title: 'The site' }] })
      expect(await client.call('GET', '/api/docs/site')).toEqual({ name: 'site', title: 'The site', text: '# The site\n\nWhat every host reads.\n' })
      for (const name of ['Bad', '..%2Fdocs%2Fsite', 'missing']) await expect(client.call('GET', `/api/docs/${name}`)).rejects.toMatchObject({ status: 404 })
    } finally { await running.close() }
  })

  it('load after the modules they need, in any order, and refuse to load twice or without them', () => {
    const order: string[] = []
    const make = (id: string, requires: string[] = []): Module => ({ id, title: id, requires, setup: () => { order.push(id) } })
    new BoardLab({ db: openDatabase(join(dir, 'order.sqlite')), modules: [make('c', ['b']), make('a'), make('b', ['a'])] })
    expect(order).toEqual(['a', 'b', 'c'])
    expect(inLoadOrder([make('x', ['y']), make('y', ['x'])].slice(0, 1)).map(module => module.id)).toEqual(['x'])
    expect(() => inLoadOrder([make('x', ['y']), make('y', ['x'])])).toThrow(/cycle/)
    const lab = new BoardLab({ db: openDatabase(join(dir, 'twice.sqlite')) })
    expect(() => lab.use(make('needy', ['missing']))).toThrow(/needs missing/)
    lab.use(make('a'))
    expect(() => lab.use(make('a'))).toThrow(/loaded twice/)
  })
})

describe('boardd configuration', () => {
  it('loads every module the distribution has by default, or those listed, with their settings', () => {
    expect(Object.keys(parseConfig({}, null, ['a', 'b']).modules)).toEqual(['a', 'b'])
    expect(parseConfig({ modules: ['b'] }, null, ['a', 'b']).modules).toEqual({ b: {} })
    expect(parseConfig({ timing: { boot: { firstMs: 5000 }, scan: { rounds: 3 }, syncMs: 30000 } }).timing).toMatchObject({ boot: { firstMs: 5000 }, scan: { rounds: 3 }, syncMs: 30000 })
    expect(() => parseConfig({ modules: 'b' })).toThrow(/modules 要是/)
    expect(() => parseConfig({ timing: { boot: { firstMs: 'soon' } } })).toThrow(/timing.boot/)
    const made: unknown[] = []
    const catalog: CatalogEntry[] = [
      { id: 'racks', about: '机架', create: (settings, context) => { const ids = instances(settings, 'rack'); return { id: 'racks', title: '机架', setup: lab => { for (const id of ids) lab.backends.register(id, new FakeLab()); made.push(context.timing.scan) } } } },
      { id: 'other', about: '别的', create: () => ({ id: 'other', title: '别的', setup: () => {} }) },
    ]
    const context = { stateDir: dir, shipped: () => null, timing: { scan: { rounds: 3 } }, release: { version: 'test', revision: 'test' } }
    const lab = new BoardLab({ db: openDatabase(join(dir, 'config.sqlite')), modules: createModules(catalog, { racks: { instances: ['rack-a', 'rack-b'] } }, context) })
    expect(lab.modules().map(item => item.id)).toEqual(['racks'])
    expect(lab.backends.labSettings().map(item => item.id)).toEqual(['rack-a', 'rack-b'])
    expect(made).toEqual([{ rounds: 3 }])
    expect(() => createModules(catalog, { racks: { instances: ['bad name'] } }, context)).toThrow(/模块 racks 的设置不对/)
    expect(() => createModules(catalog, { zigbee: {} }, context)).toThrow(/没有这些模块：zigbee/)
  })
})

describe('the bare distribution', () => {
  it('has the core\'s commands and no module\'s', () => {
    const cli = createCli({ groups: [], catalog: [] })
    const all = cli.usage('--all')
    expect(all).toMatch(/lock <board>/)
    expect(all).toMatch(/serve /)
    expect(all).not.toMatch(/^ {2}(scan|sdk|bsp)\b/m)
    // The overview: the everyday commands, then one line per group; a group or a command on its own.
    const overview = cli.usage()
    expect(overview).toMatch(/常用：/)
    expect(overview).toMatch(/^ {2}boards +锁、复位、串口、启动、日志：list show lock/m)
    expect(overview).toMatch(/^ {2}setup +状态、版本.*：status version install remote serve/m)
    expect(overview.split('\n').length).toBeLessThan(25)
    expect(cli.usage('labs')).toMatch(/^实验室：\n {2}lab kinds/)
    expect(cli.usage('reset')).toMatch(/reset <board>/)
    expect(cli.usage('flash')).toMatch(/flash <board> <链接\|文件> \[--flasher <工具>\][\s\S]*flash <board> --sdk <SDK>/)
    expect(cli.usage('nope')).toMatch(/没有这个命令或分组：nope/)
  })
})

describe('boardd API', () => {
  it('reads a console\'s log over a time range, searched, from the backend or the console\'s buffer, and offers it as a file', async () => {
    // The board here: no logs of its own, so its console's buffer.
    const lines = ['[2026-11-10 08:00:00] U-Boot 2022.10', 'continuation of the line above', '[2026-11-10 09:00:00] ERROR mmc0', '[2026-11-10 10:00:00] login:']
    const here = new Here()
    here.serial.open = async (_config, target) => ({ ...fakeSession(target.board, here.sent), history: lines })
    const { svc } = coreLab({ here })
    expect(await svc.consoles.logs('com260', undefined, { since: '2026-11-10 08:00:00', until: '2026-11-10 09:00:00' })).toMatchObject({ lines: lines.slice(0, 3), matched: 3, truncated: false, source: 'buffer', numbers: [0, 1, 2], total: 4 })
    expect(await svc.consoles.logs('com260', undefined, { grep: 'error' })).toMatchObject({ lines: ['[2026-11-10 09:00:00] ERROR mmc0'], matched: 1, numbers: [2] })
    // Where every match is, and the lines around one, by its number or its position.
    expect(await svc.consoles.logs('com260', undefined, { grep: '0:00', hits: true })).toMatchObject({ lines: [], matched: 3, hits: [0, 2, 3], total: 4 })
    const around = await svc.consoles.logs('com260', undefined, { at: 'line:2', before: 1, after: 5 })
    expect(around).toMatchObject({ lines: lines.slice(1), numbers: [1, 2, 3], moreBefore: true, moreAfter: false, snapped: false })
    expect(await svc.consoles.logs('com260', undefined, { at: around.positions![0], after: 1 })).toMatchObject({ lines: lines.slice(1, 3), at: around.positions![0] })
    expect(await svc.consoles.logs('com260', undefined, { at: 'end', before: 2 })).toMatchObject({ lines: lines.slice(2), numbers: [2, 3], moreBefore: true, moreAfter: false })
    expect(await svc.consoles.logs('com260', undefined, { at: 'line:99' })).toMatchObject({ lines: [lines[3]], snapped: true })
    expect(await svc.consoles.logs('com260', undefined, { at: 'bzz:1' })).toMatchObject({ snapped: true })
    expect(await svc.consoles.logs('com260', undefined, { limit: 1 })).toMatchObject({ lines: ['[2026-11-10 10:00:00] login:'], truncated: true })
    await expect(svc.consoles.logs('com260', undefined, { grep: '(', regex: true })).rejects.toThrow(/不是合法的正则/)
    // A lab board whose backend keeps logs: the query goes to the backend.
    const asked: unknown[] = []
    const lab = new FakeLab()
    lab.serial.logs = async (_config, target, query) => { asked.push([target.device, query]); return { lines: ['[2026-11-10 09:00:00] from the lab'], matched: 1, truncated: false } }
    svc.kernel.db.close()
    rmSync(join(dir, 'lab.sqlite'), { force: true })             // the next service starts from an empty database
    const { svc: labbed } = labService(lab)
    await enable(labbed)
    expect(await labbed.consoles.logs('lab1-sub0-0', undefined, { grep: 'lab' })).toEqual({ lines: ['[2026-11-10 09:00:00] from the lab'], matched: 1, truncated: false, source: 'backend' })
    expect(asked).toEqual([['sub0-0', { grep: 'lab', limit: 20000 }]])
    // Over HTTP: JSON for the page, a file to download for a browser or wget.
    const port = 39500 + Math.floor(Math.random() * 400)
    const running = await serve(labbed, { port, socketPath: join(dir, 'logs.sock'), uiDir: null })
    const get = (path: string) => new Promise<{ status: number, body: string, headers: Record<string, unknown> }>(resolve => {
      request({ host: '127.0.0.1', port, path }, res => { let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers })) }).end()
    })
    try {
      expect(JSON.parse((await get('/api/logs?board=lab1-sub0-0&grep=lab')).body)).toMatchObject({ matched: 1, source: 'backend' })
      const file = await get('/api/logs?board=lab1-sub0-0&since=2026-11-10%2009:00:00&until=2026-11-10%2010:00:00&download=1')
      expect(file.headers['content-disposition']).toBe('attachment; filename="lab1-sub0-0-202611100900-202611101000.log"')
      expect(file.body).toBe('[2026-11-10 09:00:00] from the lab\n')
      expect((await get('/api/logs?board=lab1-sub0-0&since=yesterday')).status).toBe(400)
    } finally { await running.close() }
  })

  it('says which release and API version it is, for clients that must match it', async () => {
    const port = 39000 + Math.floor(Math.random() * 400)
    const svc = service()
    const running = await serve(svc, { port, socketPath: join(dir, 'version.sock'), uiDir: null, version: '0.4.0rc1', revision: 'abc1234' })
    const get = (path: string) => new Promise<{ status: number, body: string }>(resolve => {
      request({ host: '127.0.0.1', port, path }, res => { let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode!, body })) }).end()
    })
    try {
      expect(JSON.parse((await get('/api/version')).body)).toEqual({ version: '0.4.0rc1', revision: 'abc1234', api: API_VERSION })
      // The models people typed in are offered to every page.
      svc.boards.update('user:alice', 'com260', { product: 'k3-typed' })
      expect(JSON.parse((await get('/api/models')).body)).toEqual({ models: ['k3-typed'] })
      // Machines (and crawlers) read the same list as a standard OpenAPI document; the index points at it.
      const index = JSON.parse((await get('/api')).body) as { openapi: string }
      expect(index.openapi).toBe('/api/openapi.json')
      const spec = JSON.parse((await get('/api/openapi.json')).body) as { openapi: string, paths: Record<string, Record<string, { summary: string, tags: string[], parameters?: Array<{ name: string }> }>> }
      expect(spec.openapi).toBe('3.1.0')
      expect(spec.paths['/api/lock']!.post!.summary).toContain('锁')
      expect(spec.paths['/api/lock']!.post!.tags.length).toBe(1)
      const withParam = Object.entries(spec.paths).find(([path]) => path.includes('{name}'))
      expect(withParam?.[1].get?.parameters?.[0]?.name ?? withParam?.[1].post?.parameters?.[0]?.name).toBe('name')
    } finally { await running.close() }
  })

  it('serves several frontends, the one picked for this boardd', async () => {
    const ui = join(dir, 'ui')
    for (const name of ['shiny', 'plain']) { mkdirSync(join(ui, name), { recursive: true }); writeFileSync(join(ui, name, 'index.html'), `<title>${name}</title>`) }
    writeFileSync(join(ui, 'frontends.json'), JSON.stringify({ default: 'shiny', frontends: [{ name: 'shiny', title: 'Shiny' }, { name: 'plain', title: 'Plain' }, { name: 'gone', title: 'Not built' }] }))
    const port = 39000 + Math.floor(Math.random() * 400)
    const svc = service()
    const running = await serve(svc, { port, socketPath: join(dir, 'ui.sock'), uiDir: ui })
    const get = (path: string) => new Promise<{ status: number, body: string }>(resolve => {
      request({ host: '127.0.0.1', port, path, method: path.includes('?name=') ? 'POST' : 'GET' }, res => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode!, body }))
      }).end()
    })
    try {
      expect((await get('/')).body).toBe('<title>shiny</title>')
      expect(JSON.parse((await get('/api/frontends')).body)).toEqual({ default: 'shiny', current: 'shiny', frontends: [{ name: 'shiny', title: 'Shiny' }, { name: 'plain', title: 'Plain' }] })
      // Picking one switches the page for everyone, whatever proxy is in front: no cookie involved.
      expect((await get('/api/frontends?name=plain')).status).toBe(200)
      expect((await get('/')).body).toBe('<title>plain</title>')
      expect(JSON.parse((await get('/api/frontends')).body).current).toBe('plain')
      expect(svc.history().actions[0]).toMatchObject({ kind: 'frontend', detail: 'plain' })
      expect((await get('/api/frontends?name=gone')).status).toBe(400)           // listed but not built
    } finally { await running.close() }
  })

  it('keeps an event stream alive with a frame a page can see, and asks for a quick retry when it is cut', async () => {
    // A browser passes nothing to the page that the stream did not send: a `: ping` comment keeps a proxy's connection
    // open, but a page behind that proxy cannot tell a live stream from one it only believes is alive. The keepalive is
    // a `ping` event, and the stream asks for a two-second retry, so a dropped one comes back without a reload.
    const port = 39000 + Math.floor(Math.random() * 400)
    const svc = service()
    const running = await serve(svc, { port, socketPath: join(dir, 'events.sock'), uiDir: null })
    const head = await new Promise<{ status: number, headers: Record<string, unknown>, body: string }>(resolve => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events' }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => {
          body += chunk
          // The stream does not end by itself: the first frames are what this reads.
          if (body.includes('event: hello')) { req.destroy(); resolve({ status: res.statusCode!, headers: res.headers, body }) }
        })
      })
      req.on('error', () => {})
      setTimeout(() => { req.destroy(); resolve({ status: 0, headers: {}, body: '' }) }, 3_000)
      req.end()
    })
    try {
      expect(head.status).toBe(200)
      expect(head.headers['content-type']).toBe('text/event-stream; charset=utf-8')
      expect(head.body).toMatch(/^retry: \d+\n\n/)                      // a cut stream is retried quickly, wherever served
      expect(head.body).toContain('event: hello\ndata: {"ok":true}\n\n')
      expect(head.body).not.toContain(': ping')                        // a comment reaches no page
    } finally { await running.close() }
  })

  it('passes a reply on as it comes, for every path under an endpoint that ends in /*', async () => {
    const svc = service()
    const seen: Array<{ rest: string, accept: unknown }> = []
    let more: (() => void) | null = null
    svc.api.add('test-pass', [{
      method: 'GET', path: '/api/pass/:id/*', about: 'pass a reply on',
      handle: ({ params, headers }) => {
        seen.push({ rest: params['*']!, accept: headers?.accept })
        if (params['*'] !== '/live') return new RawReply(201, { 'content-type': 'text/plain', 'x-from': params.id! }, (async function* () { yield 'a'; yield Buffer.from('b') })())
        return new RawReply(200, { 'content-type': 'text/event-stream' }, (async function* () { yield 'data: 1\n\n'; await new Promise<void>(resolve => { more = resolve }); yield 'data: 2\n\n' })())
      },
    }])
    expect(() => svc.api.add('test-bad', [{ method: 'GET', path: '/api/x/*/y', about: '', handle: () => null }])).toThrow('endpoint path')
    const port = 39500 + Math.floor(Math.random() * 400)
    const running = await serve(svc, { port, socketPath: join(dir, 'pass.sock'), uiDir: null })
    try {
      const plain = await fetch(`http://127.0.0.1:${port}/api/pass/h1/static/a%20b.css?v=1`, { headers: { Accept: 'text/css' } })
      expect([plain.status, plain.headers.get('x-from'), await plain.text()]).toEqual([201, 'h1', 'ab'])
      expect((await fetch(`http://127.0.0.1:${port}/api/pass/h1`)).status).toBe(201)
      expect(seen.slice(0, 2)).toEqual([{ rest: '/static/a%20b.css', accept: 'text/css' }, { rest: '', accept: '*/*' }])
      // An event stream is passed on chunk by chunk, not when it ends.
      const live = await fetch(`http://127.0.0.1:${port}/api/pass/h1/live`)
      const reader = live.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 1\n\n')
      more!()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 2\n\n')
      expect((await reader.read()).done).toBe(true)
    } finally { await running.close() }
  })

  it('sends a person\'s first keystroke through the console they are watching, without opening another', async () => {
    const here = new Here()
    let opened = 0
    const open = here.serial.open
    here.serial.open = async (...args) => { opened++; return open(...args) }
    const svc = new BoardLab({
      db: openDatabase(join(dir, 'typing.sqlite')), sleep: async () => {},
      modules: [{ id: 'test-here', title: '本机（测试）', setup: core => core.backends.register('local', here, { configurable: false, isDefault: true }) }],
    })
    svc.boards.add('user:alice', { name: 'k1', slot: 1, chips: [{ serialPath: '/dev/ttyUSB1', alias: 'k1' }] })
    const watching = await svc.consoles.open('k1')
    expect(opened).toBe(1)
    await svc.consoles.input('k1', { holder: 'user:alice' }, { data: 'ls\r', human: true })
    expect(opened).toBe(1)                                         // the watched console carried it
    expect(here.sent).toEqual(['k1: ls\r'])
    watching.close()
    // Nobody watching: input opens a session of its own, as before.
    await svc.consoles.input('k1', { holder: 'user:alice' }, { data: 'x', human: true })
    expect(here.sent.at(-1)).toBe('k1: x')
  })

  it('serves the CLI over the Unix socket, listens on opted-in hosts and refuses foreign ones', async () => {
    const svc = service()
    const socketPath = join(dir, 'boardd.sock')
    const port = 38000 + Math.floor(Math.random() * 1000)
    const running = await serve(svc, { port, hosts: ['127.0.0.2'], origins: ['https://lab.example.org/'], socketPath, uiDir: null })
    try {
      const agent = new BoardsClient(socketPath, 'claude:s9')
      const lock = await agent.lock('com260', '读日志')
      expect(lock.lease!.holder).toBe('claude:s9')
      await expect(new BoardsClient(socketPath, 'claude:other').reset('com260')).rejects.toMatchObject({ status: 423 })
      await agent.unlock('com260', lock.token)
      const ok = await fetch(`http://127.0.0.1:${port}/api/state`)
      expect((await ok.json()).you).toMatch(/^user:/)
      const extra = await fetch(`http://127.0.0.2:${port}/api/state`)
      expect(extra.status).toBe(200)
      // People on the page name themselves; malformed names fall back to the local user.
      expect((await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Boards-User': 'alice' } })).json()).you).toBe('user:alice')
      expect((await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Boards-User': 'a b' } })).json()).you).not.toBe('user:a b')
      const rebinding = await new Promise<number>((resolve, reject) => request({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: `evil.test:${port}` } }, response => { response.resume(); resolve(response.statusCode!) }).on('error', reject).end())
      expect(rebinding).toBe(403)
      const crossSite = await fetch(`http://127.0.0.1:${port}/api/lock`, { method: 'POST', headers: { Origin: 'http://evil.test' }, body: '{}' })
      expect(crossSite.status).toBe(403)
      // A remote CLI acts for an agent of the person, never for another person.
      const asAgent = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Boards-User': 'alice', 'X-Boards-Holder': 'claude:s7' } })
      expect((await asAgent.json()).you).toBe('claude:s7')
      expect((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Boards-User': 'alice', 'X-Boards-Holder': 'user:bob' } })).status).toBe(403)
      expect((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Boards-User': 'alice', 'X-Boards-Holder': 'user:alice' } })).status).toBe(200)
      // The page served through a reverse proxy at an opted-in origin may write.
      const proxied = await fetch(`http://127.0.0.1:${port}/api/unqueue`, { method: 'POST', headers: { Origin: 'https://lab.example.org' }, body: JSON.stringify({ board: 'com260' }) })
      expect(proxied.status).toBe(404)
    } finally { await running.close() }
  })
})

describe('remote boards CLI', () => {
  it('reaches a boardd elsewhere through an ssh tunnel and through a proxy with a login, as agents of the person', async () => {
    const svc = service()
    const port = 39000 + Math.floor(Math.random() * 1000)
    const running = await serve(svc, { port, socketPath: join(dir, 'boardd.sock'), uiDir: null, origins: ['http://127.0.0.1:' + (port + 1)] })
    // A fake `ssh … -W 127.0.0.1:<port> host` that opens the tunnel locally.
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'ssh'), `#!${process.execPath}\nconst [h, p] = process.argv[process.argv.indexOf('-W') + 1].split(':')\nconst s = require('node:net').connect(Number(p), h)\nprocess.stdin.pipe(s); s.pipe(process.stdout); s.on('close', () => process.exit(0))\n`, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    // The proxy in front of boardd's page, under /boardlab, with a login: what a site's proxy does.
    const proxy = createHttpServer((req, res) => {
      if (req.headers.authorization !== `Basic ${Buffer.from('alice:pw').toString('base64')}`) { res.writeHead(401); return res.end() }
      // Like a site's hub, take only sized bodies.
      if (req.method !== 'GET' && req.headers['transfer-encoding'] === 'chunked') { res.writeHead(411); return res.end() }
      const upstream = request({ host: '127.0.0.1', port, method: req.method, path: req.url!.replace(/^\/boardlab/, ''),
        headers: { ...req.headers, host: `127.0.0.1:${port}`, 'x-boards-user': 'alice' } }, answer => { res.writeHead(answer.statusCode!, answer.headers); answer.pipe(res) })
      req.pipe(upstream)
    })
    await new Promise<void>(resolve => proxy.listen(port + 1, '127.0.0.1', resolve))
    try {
      const tunnel = new BoardsClient(sshTransport(`ssh://alice@boardd.example:22?boardd=${port}`, { person: 'alice', controlDir: join(dir, 'ssh') }), 'claude:build-1')
      const lock = await tunnel.lock('com260', '远程调试')
      expect(lock.lease!.holder).toBe('claude:build-1')
      expect((await tunnel.state()).you).toBe('claude:build-1')
      await tunnel.unlock('com260', lock.token)

      const web = new BoardsClient(webTransport(`http://127.0.0.1:${port + 1}/boardlab/`, { user: 'alice', password: 'pw' }), 'user:alice')
      const mine = await web.lock('com260', '网页登录')
      expect(mine.lease!.holder).toBe('user:alice')
      // A web-only client cannot upload at all; the HTTP upload endpoint is deliberately disabled.
      const kernel = join(dir, 'Image.itb')
      writeFileSync(kernel, 'remote kernel FIT')
      await expect(web.sendFile(kernel)).rejects.toThrow(/网页上传已禁用/)
      const wrong = await fetch(`http://127.0.0.1:${port + 1}/boardlab/api/files/${sha('other')}?total=17`, { method: 'PUT', headers: { Authorization: `Basic ${Buffer.from('alice:pw').toString('base64')}` }, body: 'remote kernel FIT' })
      expect(wrong.status).toBe(403)
      expect(svc.files.get(sha('remote kernel FIT'))).toBeNull()
      await web.unlock('com260', mine.token)
      await expect(new BoardsClient(webTransport(`http://127.0.0.1:${port + 1}/boardlab`, { user: 'alice', password: 'no' })).state()).rejects.toThrow(/要登录/)
      await expect(new BoardsClient(webTransport(`http://127.0.0.1:${port + 1}/boardlab`, { user: 'alice', password: 'pw' }), 'user:bob').state()).rejects.toMatchObject({ status: 403 })
    } finally {
      process.env.PATH = path
      proxy.close()
      await running.close()
    }
  })
})

describe('console keys', () => {
  it('reads keys the way picocom does: Ctrl-A Ctrl-X leaves, Ctrl-C goes to the board', () => {
    const keys = consoleKeys()
    expect(keys(Buffer.from('ls\x03'))).toEqual({ send: Buffer.from('ls\x03'), quit: false, help: false })
    expect(keys(Buffer.from('\x01\x01a'))).toEqual({ send: Buffer.from('\x01a'), quit: false, help: false })
    expect(keys(Buffer.from('\x01\x08'))).toEqual({ send: Buffer.alloc(0), quit: false, help: true })
    // The escape can arrive in one chunk and its command in the next.
    expect(keys(Buffer.from('x\x01'))).toEqual({ send: Buffer.from('x'), quit: false, help: false })
    expect(keys(Buffer.from('\x18ignored'))).toEqual({ send: Buffer.alloc(0), quit: true, help: false })
    expect(consoleKeys()(Buffer.from('\x01\x11')).quit).toBe(true)
    expect(consoleKeys()(Buffer.from('\x1d')).send).toEqual(Buffer.from('\x1d'))
  })
})

describe('commands older clients do not know', () => {
  it('are run by boardd\'s own CLI for the caller, with the output streamed back', async () => {
    const svc = service()
    const cli = join(dir, 'fake-cli.mjs')
    writeFileSync(cli, "console.log(JSON.stringify({ args: process.argv.slice(2), holder: process.env.BOARDS_HOLDER, proxied: process.env.BOARDS_PROXIED })); console.error('progress'); process.exit(3)\n")
    const socketPath = join(dir, 'proxy.sock')
    const running = await serve(svc, { port: 41000 + Math.floor(Math.random() * 1000), socketPath, uiDir: null, cli, stateDir: dir })
    try {
      const client = new BoardsClient(socketPath, 'claude:old-cli')
      const out: string[] = []
      const result = await client.proxy(['frobnicate', 'bsp-x', '--deep'], true, (stream, text) => out.push(`${stream}:${text.trim()}`))
      expect(result.code).toBe(3)
      expect(out).toEqual(['stdout:{"args":["frobnicate","bsp-x","--deep","--json"],"holder":"claude:old-cli","proxied":"1"}', 'stderr:progress'])
      await expect(client.proxy(['console', 'bsp-x'], false, () => {})).rejects.toThrow(/要在你自己的机器上跑/)
      await expect(client.proxy(['lock', 'x', '--as', 'user:someone-else'], false, () => {})).rejects.toThrow(/不能带 --as/)
    } finally { await running.close() }
  })
})

describe('CLI arguments', () => {
  it('reads the pattern after send --wait, while lock --wait stays a switch', () => {
    const send = parseArgs(['send', 'com260', 'printenv ethaddr', '--wait', '=> ', '--timeout', '10s'])
    expect(send.positional).toEqual(['send', 'com260', 'printenv ethaddr'])
    expect(send.flags.get('wait')).toBe('=> ')
    const lock = parseArgs(['lock', 'com260', '--wait', '--for', '调试'])
    expect(lock.flags.get('wait')).toBe(true)
    expect(lock.flags.get('for')).toBe('调试')
  })

  it('takes --cancel-on-interrupt as a switch, so the files after it stay files', () => {
    const boot = parseArgs(['boot', 'k1', '--cancel-on-interrupt', 'fsbl', 'uboot'])
    expect(boot.positional).toEqual(['boot', 'k1', 'fsbl', 'uboot'])
    expect(boot.flags.get('cancel-on-interrupt')).toBe(true)
  })
})

  it('records a lock that was refused, with who asked and why not', async () => {
    const { svc } = labService()
    await enable(svc)
    await svc.locks.lock('lab1-sub0-0', 'user:bob', '跑回归')
    await expect(svc.locks.lock('lab1-sub0-0', 'user:alice', '调试')).rejects.toThrow(/正被 user:bob 使用/)
    const refused = svc.history().actions.find(action => action.actor === 'user:alice' && action.kind === 'lock' && !action.ok)
    expect(refused).toMatchObject({ board: 'lab1-sub0-0', detail: '调试', ok: false })
    expect(refused!.message).toMatch(/正被 user:bob 使用/)
  })

  it('an agent asking for a board a person holds waits for the answer, and the person can let it go', async () => {
    const { svc } = labService()
    await enable(svc)
    const board = 'lab1-sub0-0'
    await svc.locks.lock(board, 'user:bob', '跑回归')
    const asked = svc.locks.lock(board, 'claude:bisect', 'bisect mmc')
    await new Promise(resolve => setImmediate(resolve))
    expect(svc.locks.yieldsList()).toEqual([expect.objectContaining({ board, holder: 'claude:bisect', owner: 'user:bob', purpose: 'bisect mmc' })])
    // Only the holder is told about it, and only the holder answers.
    expect(svc.locks.yieldsList('user:alice')).toEqual([])
    expect(svc.locks.yieldsList('user:bob')).toHaveLength(1)
    expect(() => svc.locks.answerYield(board, 'claude:bisect', 'yield')).toThrow(/只有拿着/)
    expect(svc.locks.answerYield(board, 'user:bob', 'yield')).toMatch(/让出了/)
    // A second answer (another window, a second click) says it was answered instead of failing.
    expect(svc.locks.answerYield(board, 'user:bob', 'yield')).toMatch(/已经回答过了/)
    const got = await asked
    expect(got.lease?.holder).toBe('claude:bisect')
    expect(svc.locks.held(board)?.holder).toBe('claude:bisect')
    expect(svc.history().actions.some(action => action.kind === 'yield' && action.ok)).toBe(true)
    expect(svc.history().actions.some(action => action.kind === 'yield-request')).toBe(true)
  })

  it('an agent asking is refused when the person keeps the board, or does not answer in time', async () => {
    const { svc } = labService()
    await enable(svc)
    const board = 'lab1-sub0-1'
    svc.locks.yieldTimeoutMs = 80
    await svc.locks.lock(board, 'user:bob', '调试')
    const denied = svc.locks.lock(board, 'claude:x', '试一下')
    await new Promise(resolve => setImmediate(resolve))
    svc.locks.answerYield(board, 'user:bob', 'deny')
    await expect(denied).rejects.toThrow(/没有让出/)
    const timed = svc.locks.lock(board, 'claude:y', '再试')
    await expect(timed).rejects.toThrow(/没有让出/)
    expect(svc.locks.held(board)?.holder).toBe('user:bob')
  })

describe('a board\'s debug path', () => {
  /** A lab whose boards can be debugged: a path that opens a trace channel or refuses to. */
  class DebugLab extends FakeLab {
    traces: string[] = []
    refuse = false
    async debugStream(_config: LabConfig, target: { device: string }): Promise<ConsoleSession> {
      if (this.refuse) throw new Error('the board host says: its debug session is not running')
      this.traces.push(target.device)
      const listeners = new Set<(data: Buffer) => void>()
      const closes: Array<(reason: string) => void> = []
      setTimeout(() => { listeners.forEach(fn => fn(Buffer.from('pc 0x1000\r\n'))); setTimeout(() => closes.forEach(fn => fn('closed')), 5) }, 1)
      return {
        hello: { alias: target.device, device: null, baud: 0, transport: 'debug' }, history: [],
        send: () => {}, onOutput: fn => { listeners.add(fn); return () => listeners.delete(fn) },
        onClose: fn => { closes.push(fn) }, close: () => listeners.clear(),
      }
    }
    debug = {
      path: async () => ({ provider: 'fake-swd', title: 'fake SWD', about: '', kinds: ['halt', 'trace'], running: false, endpoint: null, state: [] }),
      start: async () => ({ provider: 'fake-swd', title: 'fake SWD', about: '', kinds: ['halt', 'trace'], running: true, endpoint: '127.0.0.1:3334', state: [] }),
      stop: async () => 'stopped',
      action: async (_config: LabConfig, _target: unknown, action: string) => ({ message: `${action} done`, data: [] }),
      stream: (config: LabConfig, target: { device: string }) => this.debugStream(config, target),
    }
  }

  const streamOf = async (svc: BoardLab, board: string) => {
    const reply = await svc.api.match('GET', '/api/debug/stream')!.endpoint.handle({
      body: {}, query: new URLSearchParams({ board }), params: {}, caller: { holder: 'user:alice', local: true },
      signal: new AbortController().signal, upload: null,
    }) as RawReply
    let text = ''
    for await (const chunk of reply.body!) text += chunk.toString()
    return text
  }

  it('shows on the board what its lab can debug it with', async () => {
    // The page and `boardlab show` read the board's own record: a listing's debug block has to reach it, or a board
    // whose host has a debug path shows as having none.
    const lab = new DebugLab()
    const original = lab.listed
    ;(lab as any).listed = original.map((device, index) => index === 0
      ? { ...device, debug: { provider: 'fake-swd', title: 'fake SWD', kinds: ['halt', 'trace'] } } : device)
    const { svc } = coreLab({ lab })
    await enable(svc)
    expect(svc.boards.get('lab1-sub0-0').lab?.debug).toEqual({ provider: 'fake-swd', title: 'fake SWD', kinds: ['halt', 'trace'] })
    // A board its lab does not list as debuggable carries no block at all.
    expect(svc.boards.get('lab1-sub0-1').lab?.debug ?? null).toBeNull()
  })

  it('stops a session its lock ended, so a board is never left debugged by nobody', async () => {
    // The endpoint promises the session follows the lock. The session runs in the backend (a process, a unit, two
    // held pins), which nothing in boardd watches: ending the lock is the only thing that ends it.
    const lab = new DebugLab()
    const stops: string[] = []
    ;(lab.debug as any).stop = async () => { stops.push('stopped'); return 'stopped' }
    const { svc } = coreLab({ lab })
    await enable(svc)
    const { token } = await svc.locks.lock('lab1-sub0-0', 'user:alice', '调试')
    const debug = (body: Record<string, unknown>) => svc.api.match('POST', '/api/debug')!.endpoint.handle({
      body, query: new URLSearchParams(), params: {}, caller: { holder: 'user:alice', local: true },
      signal: new AbortController().signal, upload: null,
    })
    await debug({ board: 'lab1-sub0-0', action: 'start', token })
    expect(stops).toEqual([])
    svc.locks.unlock('lab1-sub0-0', { holder: 'user:alice', token })
    // The end listener runs on a microtask; the stop itself is asynchronous.
    for (let i = 0; i < 50 && stops.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 2))
    expect(stops).toEqual(['stopped'])
    // A session stopped by hand is not stopped a second time when the lock ends.
    try { await debug({ board: 'lab1-sub0-0', action: 'stop', token }) } catch { /* the lock is gone; the stop itself is what this checks */ }
    expect(stops).toEqual(['stopped'])
  })

  it('streams a session\'s bytes and ends with it, so a reader is never left waiting on a closed session', async () => {
    const lab = new DebugLab()
    const { svc } = coreLab({ lab })
    await enable(svc)
    const text = await streamOf(svc, 'lab1-sub0-0')
    expect(text).toContain(Buffer.from('pc 0x1000\r\n').toString('base64'))
    expect(lab.traces).toEqual(['sub0-0'])
  })

  it('refuses a session that cannot be opened, rather than sending its error text as the board\'s output', async () => {
    const lab = new DebugLab()
    lab.refuse = true
    const { svc } = coreLab({ lab })
    await enable(svc)
    await expect(streamOf(svc, 'lab1-sub0-0')).rejects.toThrow(/打不开 lab1-sub0-0 的调试输出.*not running/)
  })
})


describe('a debug stream that cannot open', () => {
  it('is a failed command, not a success that printed why it failed', async () => {
    // As the program runs it: boardd refusing the stream must be the CLI's exit status too, or a script reads
    // "the session is not running" as if the trace had been read.
    const lab = new FakeLab()
    ;(lab as unknown as { debug: unknown }).debug = {
      path: async () => ({ provider: 'fake-swd', kinds: ['trace'], running: false, endpoint: null, state: [] }),
      stream: async () => { throw new Error('its debug session is not running') },
    }
    const { svc } = coreLab({ lab })
    await enable(svc)
    const sockets = join(dir, 'cli.sock')
    const running = await serve(svc, { port: 41000 + Math.floor(Math.random() * 1000), socketPath: sockets, uiDir: null, stateDir: dir })
    try {
      // The command itself, against that boardd, the way the CLI wires it.
      const { debugCommands } = await import('../src/cli/commands/debug.ts')
      const command = debugCommands.commands.find(item => item.name === 'debug')!
      const client = new BoardsClient(sockets, 'user:alice')
      const previous = process.exitCode
      process.exitCode = undefined
      try {
        await expect(command.run({
          args: ['stream', 'lab1-sub0-0'], argv: [], flags: new Map(), flag: () => undefined, json: false,
          out: (value: unknown) => console.log(JSON.stringify(value)), stateDir: dir, catalog: [], client, holder: 'user:alice',
          remote: false, target: () => ({ board: 'lab1-sub0-0', die: undefined }),
          token: () => null, keepToken: () => {},
        } as never)).rejects.toThrow(/not running/)
        expect(process.exitCode).toBe(1)
      } finally { process.exitCode = previous }
    } finally { await running.close() }
  })
})
