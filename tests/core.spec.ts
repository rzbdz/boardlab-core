/**
 * The core against fake backends: locks and queues, the backend contract (relay, consoles, download, leases, slots,
 * discovery, refresh), modules, configuration, the HTTP gateway and the CLI. Distributions test their modules.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardsClient, sshTransport, webTransport } from '../src/shared/client.ts'
import { consoleKeys, createCli, parseArgs } from '../src/cli/main.ts'
import { openDatabase } from '../src/core/db.ts'
import { BoardLab, inLoadOrder } from '../src/core/lab.ts'
import { main } from '../bare/boardlab.ts'
import { BoardError } from '../src/core/errors.ts'
import type { LabFields } from '../src/shared/types.ts'
import type { Module } from '../src/core/module.ts'
import type { ConsoleSession } from '../src/core/console.ts'
import { serve } from '../src/server/http.ts'
import { parseConfig } from '../src/server/config.ts'
import { createModules, instances, type CatalogEntry } from '../src/server/catalog.ts'
import { deviceFilter, type Backend, type BoardTarget, type DownloadCapability, type LabConfig, type LabDevice, type PortTiming, type RelayCapability } from '../src/core/backend.ts'

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
    name, model: 'k3', online: index !== 2, serialPort: `/dev/ttyS_${index}`, serialConnected: index !== 1, downloadUsbPath: `1-2.${index + 1}`, ip: `10.0.0.${index + 10}`,
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
      hello: { alias: device, device: null, baud: 115200, transport: 'lab' }, history: [`[${device}] k3 login:`],
      send: data => { this.sent.push(`${device}: ${data}`); setTimeout(() => listeners.forEach(fn => fn(Buffer.from(`${data}root@k3:~# `))), 5) },
      onOutput: fn => { listeners.add(fn); return () => listeners.delete(fn) },
      onClose: () => {},
      close: () => listeners.clear(),
    }
  }
  async stage(_config: LabConfig, usbPath: string, file: { path: string, sha256: string }) { this.staged.push({ usbPath, sha256: file.sha256 }); return 'OKAY' }
  async present(_config: LabConfig, usbPath: string) { return !this.gone.has(usbPath) }
}

function coreLab(options: { lab?: Backend, now?: () => number } = {}) {
  const here = new Here()
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
function shipFirmware(purpose: string, content: string, soc = 'k3') {
  const firmwareDir = join(dir, 'firmware')
  mkdirSync(firmwareDir, { recursive: true })
  writeFileSync(join(firmwareDir, `${purpose}.bin`), content)
  writeFileSync(join(firmwareDir, 'firmware.json'), JSON.stringify([{ soc, purpose, file: `${purpose}.bin`, sha256: sha(content) }]))
  return join(firmwareDir, `${purpose}.bin`)
}

describe('holders', () => {
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
      ['lab1-sub0-0', { id: 'lab1', device: 'sub0-0', online: true, ip: '10.0.0.10', heldBy: null, leaseError: null, attention: null, canConfirm: false, empty: false, slotGone: false, canRefresh: false, mediaBoot: null, sdks: [], progress: null }, 'lab', 'k3', null],
      ['lab1-sub0-1', { id: 'lab1', device: 'sub0-1', online: true, ip: '10.0.0.11', heldBy: null, leaseError: null, attention: null, canConfirm: false, empty: false, slotGone: false, canRefresh: false, mediaBoot: null, sdks: [], progress: null }, 'lab', 'k3', null],
    ])
    expect(listed.map(board => board.chips.map(chip => [chip.serialPath, chip.downloadUsbPath, chip.online, chip.alias]))).toEqual([[['/dev/ttyS_0', '1-2.1', true, null]], [['/dev/ttyS_1', '1-2.2', false, null]]])
    // A board whose system has not reported its model yet keeps the one it had.
    lab.listed[0]!.model = null
    await svc.backends.sync('lab1')
    expect(svc.boards.get('lab1-sub0-0')).toMatchObject({ product: 'k3', soc: 'k3' })
    // The password stays write-only, a wrong one is reported without echoing it, and saving without one keeps it.
    const bad = await enable(svc, { password: 'wrong-password' })
    expect(bad).toMatchObject({ verifyOk: false, verifyMessage: '后台拒绝了账号或密码（401）' })
    expect((await enable(svc, { password: 'lab-password', jump: 'ops@lab.test:2222' })).verifyOk).toBe(true)
    expect((await enable(svc, { password: null, jump: 'ops@lab.test:2222' })).verifyOk).toBe(true)
    expect(lab.calls.at(-1)).toBe('verify admin ops@lab.test:2222')
    expect(JSON.stringify([svc.state('user:alice'), svc.history()])).not.toMatch(/lab-password|wrong-password/)
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

    expect(await svc.consoles.send('lab1-sub0-0', claude, { text: 'uname -a', wait: 'root@k3' })).toMatchObject({ matched: true })
    expect(lab.sent).toEqual(['sub0-0: uname -a\n'])
    expect(await svc.consoles.log('lab1-sub0-0')).toEqual(['[sub0-0] k3 login:'])
    // A listing that says the port is down can be a minute old; opening the console asks the lab.
    expect(svc.boards.get('lab1-sub0-1').chips[0]!.online).toBe(false)
    expect((await svc.consoles.open('lab1-sub0-1')).history).toEqual(['[sub0-1] k3 login:'])

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
    await svc.consoles.send('lab1-sub0-0', { holder: 'claude:s1', token }, { text: 'uname -a', wait: 'root@k3' })
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
      boots: unknown[] = []
      async boot(_config: LabConfig, device: string, files: Array<{ path: string, sha256: string }>, lease: string | null, timing: PortTiming) {
        this.boots.push({ device, files: files.map(file => file.sha256), lease, first: timing.firstMs })
        return 'job boot-1 succeeded'
      }
      constructor() { super(); this.download.boot = (config, target, files, timing) => this.boot(config, target.device, files, target.lease, timing) }
    }
    const lab = new BootingLab()
    const { svc } = labService(lab)
    await enable(svc)
    const { token } = await svc.locks.lock('lab1-sub0-0', 'claude:s1', '内存启动')
    shipFirmware('fsbl', 'shipped FSBL')
    const kernel = join(dir, 'Image.itb')
    writeFileSync(kernel, 'kernel FIT')
    const output = await svc.download.boot('lab1-sub0-0', { holder: 'claude:s1', token }, { files: ['fsbl', kernel] })
    expect(lab.boots).toEqual([{ device: 'sub0-0', files: [sha('shipped FSBL'), sha('kernel FIT')], lease: null, first: 0 }])
    expect(lab.staged).toEqual([])
    expect(output).toContain('job boot-1 succeeded')
  })

  it('lets a lab with its own registry find new boards while others are held, and forget a board only while nobody holds it', async () => {
    class RegistryLab extends FakeLab {
      async discover(_config: LabConfig, options: { human?: boolean, host?: string | null }, progress: (line: string) => void) {
        progress('ACTION NEEDED (board 1): put ONE unregistered board into download mode')
        this.calls.push(`discover ${options.human ? `human ${options.host}` : 'gpio'}`)
        return { message: '发现 1 块新板子', found: [{ host: 'lab-9', name: 'k3-board', summary: 'lab-9 上的新板子', warnings: [], detail: { console: 'c9' } }] }
      }
      async slots() { return [{ host: 'lab-9', consoles: [{ id: '/dev/ttyUSB5', label: '/dev/ttyUSB5' }, { id: 'ttyUSB5', label: '/dev/ttyUSB5' }], usb: [{ id: 'usb:1-3', label: 'usb:1-3 DFU' }] }] }
      async bind(_config: LabConfig, host: string, ports: { console: string, usb: string }, name: string) {
        this.listed.push({ ...this.listed[0]!, name, heldBy: null }); this.calls.push(`bind ${host} ${ports.console} ${ports.usb} ${name}`)
      }
      async register(_config: LabConfig, finding: { detail: unknown }, name: string) {
        this.listed.push({ ...this.listed[0]!, name, heldBy: null }); this.calls.push(`register ${name} ${JSON.stringify(finding.detail)}`)
      }
      async remove(_config: LabConfig, device: string) { this.listed = this.listed.filter(item => item.name !== device); this.calls.push(`remove ${device}`) }
      discovery = { discover: this.discover.bind(this), register: this.register.bind(this) }
      ports = { list: this.slots.bind(this), bind: this.bind.bind(this) }
      constructor() { super(); this.inventory.remove = this.remove.bind(this) }
    }
    const lab = new RegistryLab()
    const { svc } = labService(lab)
    await enable(svc)
    expect(svc.backends.labSettings()[0]).toMatchObject({ canDiscover: true, canRemove: true })
    await expect(svc.backends.discover('user:alice', 'lab1', false)).rejects.toThrow(/需要用户确认/)
    const { token } = await svc.locks.lock('lab1-sub0-0', 'claude:s1', '调试')
    // Finding boards uses only free lines and consoles: a board in use does not stop it.
    expect(await svc.backends.discover('user:alice', 'lab1', true)).toMatchObject({ message: '发现 1 块新板子' })
    await expect(svc.boards.remove('user:alice', 'lab1-sub0-0')).rejects.toThrow(/正被 claude:s1 使用/)
    svc.locks.unlock('lab1-sub0-0', { holder: 'claude:s1', token })
    const seen: string[] = []
    svc.events.on('event', () => { const line = svc.backends.labSettings()[0]!.discovery?.line; if (line && seen.at(-1) !== line) seen.push(line) })
    expect(await svc.backends.discover('user:alice', 'lab1', true, { human: true, host: 'lab-9' })).toEqual({ message: '发现 1 块新板子', proposals: 1, registered: [] })
    expect(seen.slice(0, 2)).toEqual(['开始人工发现（lab-9）：按提示逐块让未登记的板子进下载模式', 'ACTION NEEDED (board 1): put ONE unregistered board into download mode'])
    expect(svc.backends.labSettings()[0]!.discovery).toMatchObject({ running: false, line: '发现 1 块新板子' })
    // Nothing is registered until the proposal is applied, under the name the person gives.
    expect(svc.boards.list().map(board => board.name)).not.toContain('lab1-sub0-9')
    const [proposal] = svc.state('user:alice').proposals
    expect(proposal).toMatchObject({ kind: 'new-board', summary: 'lab-9 上的新板子', change: { lab: 'lab1', name: 'k3-board' } })
    await expect(svc.proposals.resolve('user:alice', [proposal!.id], 'apply', { [proposal!.id]: 'bad name' })).rejects.toThrow(/板名不合法/)
    await svc.proposals.resolve('user:alice', [proposal!.id], 'apply', { [proposal!.id]: 'sub0-9' })
    expect(svc.state('user:alice').proposals).toEqual([])
    await expect(svc.backends.discover('user:alice', 'lab1', true, { human: true, host: 'bad host' })).rejects.toThrow(/主机名不合法/)
    expect(svc.boards.list().map(board => board.name)).toContain('lab1-sub0-9')
    await svc.boards.remove('user:alice', 'lab1-sub0-9')
    expect(svc.boards.list().map(board => board.name)).not.toContain('lab1-sub0-9')
    await svc.backends.sync('lab1')
    expect(svc.boards.list().map(board => board.name)).not.toContain('lab1-sub0-9')
    // Free ports a new cable shows up as become a board reset by a person, named after them unless named.
    expect(svc.backends.labSettings()[0]!.canBind).toBe(true)
    // The first ask has nothing to show yet and asks in the background; afterwards the answer is shown at once.
    expect(await svc.backends.ports('lab1')).toMatchObject({ hosts: [], at: null, refreshing: true })
    await svc.backends.refreshPorts('lab1')
    expect(await svc.backends.ports('lab1')).toMatchObject({ hosts: [{ host: 'lab-9', consoles: [{ id: '/dev/ttyUSB5', label: '/dev/ttyUSB5' }, { id: 'ttyUSB5', label: '/dev/ttyUSB5' }], usb: [{ id: 'usb:1-3', label: 'usb:1-3 DFU' }] }], refreshing: false, error: null })
    // Binding checks the ports again: one that went away meanwhile is refused.
    await expect(svc.backends.bind('user:alice', 'lab1', { host: 'lab-9', console: 'ttyUSB9', usb: 'usb:1-3' })).rejects.toThrow(/串口 ttyUSB9已经不空闲了/)
    expect(await svc.backends.bind('user:alice', 'lab1', { host: 'lab-9', console: '/dev/ttyUSB5', usb: 'usb:1-3' })).toBe('lab1-tmp-lab-9-ttyUSB5')
    await enable(svc, { devices: '' })
    expect(svc.boards.list().map(board => board.name)).toContain('lab1-tmp-lab-9-ttyUSB5')
    await expect(svc.backends.bind('user:alice', 'lab1', { host: 'lab-9', console: 'x; rm -rf /', usb: 'usb:1-3' })).rejects.toThrow(/不合法/)
    expect(lab.calls.filter(call => !call.startsWith('verify'))).toEqual(['discover gpio', 'discover human lab-9', 'register sub0-9 {"console":"c9"}', 'remove sub0-9', 'bind lab-9 /dev/ttyUSB5 usb:1-3 tmp-lab-9-ttyUSB5'])
  })

  it('shows what a person must do while a lab board\'s reset waits for them, and lets them confirm', async () => {
    class HumanLab extends FakeLab {
      release: (() => void) | null = null
      async reset(_config: LabConfig, _device: string, _lease?: string | null, notice?: (message: string | null) => void) {
        notice?.('press RESET on slot-1')
        await new Promise<void>(resolve => { this.release = resolve })
        notice?.(null)
      }
      async confirm(_config: LabConfig, device: string, note: string) { this.calls.push(`confirm ${device} ${note}`); this.release?.(); return '已确认「reset」' }
      constructor() { super(); this.relay.confirm = (config, target, note) => this.confirm(config, target.device, note) }
    }
    const lab = new HumanLab()
    const { svc } = labService(lab)
    await enable(svc)
    const { token } = await svc.locks.lock('lab1-sub0-0', 'claude:s1', '调试')
    const told: unknown[] = []
    svc.events.on('event', event => { if (event.type === 'attention') told.push(event) })
    const reset = svc.relay.reset('lab1-sub0-0', { holder: 'claude:s1', token })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(svc.boards.get('lab1-sub0-0').lab).toMatchObject({ attention: 'press RESET on slot-1', canConfirm: true })
    // The person at the board confirms; they need not hold the lock.
    expect(await svc.relay.confirm('lab1-sub0-0', 'user:alice', '按了')).toBe('已确认「reset」')
    await reset
    expect(svc.boards.get('lab1-sub0-0').lab?.attention).toBeNull()
    expect(told).toEqual([
      { type: 'attention', board: 'lab1-sub0-0', message: 'press RESET on slot-1', holder: 'claude:s1' },
      { type: 'attention', board: 'lab1-sub0-0', message: null, holder: 'claude:s1' },
    ])
    expect(lab.calls.at(-1)).toBe('confirm sub0-0 按了')
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
    expect(again.history).toEqual(['[sub0-0] k3 login:'])
    again.close()
    clock += 60_000
    expect(svc.consoles.reap().watching).toEqual([])
    await svc.consoles.open('lab1-sub0-0')
    expect(lab.consoles).toHaveLength(2)
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
    expect(lab.boots).toEqual([{ device: 'sub0-0', sdk: 'sdk-a', method: 'download', variant: null, lease: null }])
    expect(seen).toContain('boot k3-a with sdk-a [load]: 10 steps')
    expect(svc.boards.get('lab1-sub0-0').lab?.progress).toBeNull()
    expect(svc.boards.detail('lab1-sub0-0').actions[0]).toMatchObject({ kind: 'flash', detail: 'sdk-a 刷机', ok: true })
    await expect(svc.download.build('com260', { holder: 'user:alice' }, { sdk: 'sdk-a' })).rejects.toThrow()
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
        discover: async () => ({ message: '', found: [] }),
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
        discover: async () => ({ message: '', found: [] }), register: async () => {}, keepsInUse: true,
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
    const client = new BoardsClient({ label: 'test', request: (method, path, headers) => request({ host: '127.0.0.1', port, method, path, headers }) })
    try {
      expect(await client.call('GET', '/api/state')).toEqual({ ok: true })
      expect(seen).toBe(2)
      seen = 0
      await expect(client.call('POST', '/api/lock', {})).rejects.toThrow(/socket hang up/)
      expect(seen).toBe(1)
    } finally { server.close() }
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
        discover: (_config: LabConfig, _options: unknown, report: (line: string) => void) => { progress = report; return new Promise<{ message: string, found: [] }>(resolve => { finish = () => resolve({ message: '没找到', found: [] }) }) },
        register: async () => {},
      }
    }
    const { svc } = labService(new SlotLab())
    await enable(svc, { devices: '' })
    const running = svc.backends.discover('user:alice', 'lab1', true, { slots: ['h1/s2'] })
    await new Promise(resolve => setImmediate(resolve))
    expect(svc.boards.get('lab1-h1-s2').busy).toMatchObject({ kind: 'discover', label: '发现中', by: 'user:alice' })
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
      discovery = { discover: async () => { if (fail) throw fail; return { message: '没找到', found: [] } }, register: async () => {} }
    }
    const { svc } = labService(new SlotLab())
    await enable(svc, { devices: '' })
    const discovery = () => svc.backends.labSettings()[0]!.discovery
    let done!: () => void
    const resetting = svc.kernel.doing(['lab1-h1-s2'], 'reset', '复位中', 'user:bob', () => new Promise<void>(resolve => { done = resolve }))
    await expect(svc.backends.discover('user:alice', 'lab1', true, { slots: ['h1/s2'] })).rejects.toThrow(/正在复位/)
    expect(discovery()?.line).toMatch(/^没开始：/)
    done(); await resetting
    expect(svc.history().actions.some(action => action.kind === 'lab-discover')).toBe(false)
    // The backend's own conflict, mid-search, is a failure, and recorded.
    fail = new BoardError('conflict', 'the host is probing already')
    await expect(svc.backends.discover('user:alice', 'lab1', true, { slots: ['h1/s2'] })).rejects.toThrow(/probing already/)
    expect(discovery()?.line).toBe('失败：the host is probing already')
    expect(svc.history().actions.find(action => action.kind === 'lab-discover')).toMatchObject({ ok: false, message: 'the host is probing already' })
  })

  it('refuses to rediscover with a backend that can only rebuild a whole host', async () => {
    class WholeLab extends FakeLab { discovery = { discover: async () => ({ message: '', found: [] }), register: async () => {}, rebuild: async () => ({ message: '', found: [] }) } }
    const { svc } = labService(new WholeLab())
    await enable(svc, { devices: '' })
    expect(svc.backends.labSettings()[0]).toMatchObject({ canRebuild: true, canRediscover: false })
    await expect(svc.backends.rebuild('user:alice', 'lab1', true, 'h1', true)).rejects.toThrow(/只能整台重建/)
  })

  it('finds new boards while others are held, by reset lines or by a person pairing them', async () => {
    const lab = new FakeLab()
    const asked: unknown[] = []
    ;(lab as unknown as { discovery: unknown }).discovery = {
      discover: async (_config: LabConfig, options: unknown) => { asked.push(options); return { message: '配对了 1 块', found: [] } },
      register: async () => {},
    }
    const { svc } = labService(lab)
    await enable(svc)
    await svc.locks.lock('lab1-sub0-0', 'user:bob', '调试')
    // The backend pulses only reset lines no board uses, so a held board does not stop it.
    expect((await svc.backends.discover('user:alice', 'lab1', true, {})).message).toBe('配对了 1 块')
    expect((await svc.backends.discover('user:alice', 'lab1', true, { human: true, host: 'h1' })).message).toBe('配对了 1 块')
    expect(asked).toEqual([{ human: false, host: null, slots: [] }, { human: true, host: 'h1', slots: [] }])
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
        discover: async (_config: LabConfig, options: { slots?: string[] }, _progress: (line: string) => void, registered?: (device: string) => void) => {
          this.calls.push(`discover ${options.slots?.join(',')}`)
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
    expect(await svc.backends.discover('user:alice', 'lab1', true, { slots: ['h1/s2'] })).toMatchObject({ registered: ['k3-new'] })
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
    const context = { stateDir: dir, shipped: () => null, timing: { scan: { rounds: 3 } } }
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
    expect(cli.usage('nope')).toMatch(/没有这个命令或分组：nope/)
  })
})

describe('boardd API', () => {
  it('reads a console\'s log over a time range, searched, from the backend or the console\'s buffer, and offers it as a file', async () => {
    // The board here: no logs of its own, so its console's buffer.
    const svc = service()
    const lines = ['[2026-11-10 08:00:00] U-Boot 2022.10', 'continuation of the line above', '[2026-11-10 09:00:00] ERROR mmc0', '[2026-11-10 10:00:00] login:']
    ;(svc.consoles as unknown as { log: () => Promise<string[]> }).log = async () => lines
    expect(await svc.consoles.logs('com260', undefined, { since: '2026-11-10 08:00:00', until: '2026-11-10 09:00:00' })).toEqual({ lines: lines.slice(0, 3), matched: 3, truncated: false, source: 'buffer' })
    expect(await svc.consoles.logs('com260', undefined, { grep: 'error' })).toMatchObject({ lines: ['[2026-11-10 09:00:00] ERROR mmc0'], matched: 1 })
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
      // Boot files from the remote machine are sent once, checked, and booted by their sha256.
      const kernel = join(dir, 'Image.itb')
      writeFileSync(kernel, 'remote kernel FIT')
      const ref = await web.sendFile(kernel)
      expect(ref).toBe(`sha256:${sha('remote kernel FIT')}`)
      expect(await web.sendFile(kernel)).toBe(ref)
      expect(svc.files.get(sha('remote kernel FIT'))!.path).toMatch(/Image\.itb$/)
      const wrong = await fetch(`http://127.0.0.1:${port + 1}/boardlab/api/files/${sha('other')}`, { method: 'PUT', headers: { Authorization: `Basic ${Buffer.from('alice:pw').toString('base64')}` }, body: 'remote kernel FIT' })
      expect(wrong.status).toBe(400)
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
})
