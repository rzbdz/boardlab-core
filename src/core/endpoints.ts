/** The endpoints of the core: state, locks, the relay, consoles, download, files, inventory, backends and proposals. */
import type { BoardEvent } from '../shared/types.ts'
import type { ChannelAction } from './backend.ts'
import { EventStream, FileReply, optional, required, TextReply, type Endpoint } from './api.ts'
import { BoardError } from './errors.ts'
import { pinNumbers } from '../shared/pins.ts'
import type { BoardLab } from './lab.ts'
import { stripAnsi } from './text.ts'

/** The newest of `lines` that fit in `bytes` (at least the last one), for a console's opening history. */
export function recent(lines: string[], bytes: number): string[] {
  let used = 0, at = lines.length
  while (at > 0 && used + lines[at - 1]!.length + 1 <= bytes) { used += lines[at - 1]!.length + 1; at-- }
  return lines.slice(at)
}

export function coreEndpoints(lab: BoardLab): Endpoint[] {
  const token = (body: any) => typeof body?.token === 'string' ? body.token : null
  const who = (holder: string, body: any) => ({ holder, token: token(body) })
  // A board by its name or its slot (`<host>/s3`, `slot:5`).
  const board = (body: any) => lab.boards.resolve(required(body.board, 'board'))
  const named = (value: string | null, what = 'board') => lab.boards.resolve(required(value, what))
  // An operation on one board under its lock, shown on it while it runs. Only the lock's holder gets that far, so
  // someone refused never marks the board busy for the holder meanwhile.
  // It lasts as long as the lock: `signal` aborts once the lock is released or stolen. A load or a flash (`untilDone`)
  // is not stopped halfway: the board stays busy until it ends, so the next holder sees it is still being written.
  // `line` shows a progress line on the board while it runs.
  const doing = <T>(name: string, kind: string, label: string, holder: string, body: any, run: (signal: AbortSignal, line: (text: string) => void) => Promise<T>, untilDone = false) => {
    const lease = lab.locks.authorize(name, who(holder, body))
    return lab.kernel.doing([name], kind, label, holder, (line, signal) => run(signal, line), { lease: untilDone ? null : lease.id })
  }
  return [
    { method: 'GET', path: '/api', about: '列出所有接口和模块', handle: () => ({ endpoints: lab.api.list().map(item => `${item.method} ${item.path}`), described: lab.api.list(), modules: lab.modules() }) },
    { method: 'GET', path: '/api/modules', about: '装了哪些模块', handle: () => lab.modules() },
    { method: 'GET', path: '/api/state', about: '全貌：板子、锁、后端、建议，和各模块的部分', handle: ({ caller }) => lab.state(caller.holder) },
    { method: 'GET', path: '/api/board', about: '一块板子的详情和最近的操作', handle: ({ query }) => lab.boards.detail(named(query.get('name'), 'name')) },
    { method: 'GET', path: '/api/history', about: '最近的操作和锁', handle: () => lab.history() },
    { method: 'GET', path: '/api/export.toml', about: '手工和扫描登记的板子，TOML', handle: () => new TextReply(lab.boards.exportToml()) },
    {
      method: 'GET', path: '/api/events', about: '事件流：变化、锁的交接、要人操作', handle: () => new EventStream((emit, _end, signal) => {
        const listener = (event: BoardEvent) => emit(event.type, event)
        lab.events.on('event', listener)
        signal.addEventListener('abort', () => lab.events.off('event', listener), { once: true })
        emit('hello', { ok: true })
      }),
    },

    // ---------- locks ----------
    { method: 'POST', path: '/api/lock', about: '拿锁（queue: join 排队，wait 等到拿到）', handle: ({ body, caller, signal }) => lab.locks.lock(board(body), caller.holder, String(body.purpose ?? ''), { queue: body.queue === 'join' || body.queue === 'wait' ? body.queue : 'none', signal }) },
    { method: 'POST', path: '/api/unlock', about: '放锁', handle: ({ body, caller }) => { lab.locks.unlock(board(body), who(caller.holder, body)) } },
    { method: 'GET', path: '/api/yields', about: 'AI 在等你让出的板子（拿了锁的人看得到，可以回答）', handle: () => lab.locks.yieldsList() },
    {
      method: 'POST', path: '/api/yields', about: '回答 AI 的让出请求：board、action=yield（让出）或 deny（继续用）；只有拿锁的人能答',
      handle: ({ body, caller }) => ({ message: lab.locks.answerYield(board(body), caller.holder, body.action === 'deny' ? 'deny' : 'yield') }),
    },
    { method: 'POST', path: '/api/unqueue', about: '离开队列', handle: ({ body, caller }) => { lab.locks.unqueue(board(body), caller.holder) } },
    { method: 'POST', path: '/api/steal', about: '抢锁（只有人可以，要写原因）', handle: ({ body, caller }) => lab.locks.steal(board(body), caller.holder, String(body.reason ?? '')) },

    // ---------- relay ----------
    { method: 'POST', path: '/api/reset', about: '复位', handle: async ({ body, caller }) => { const name = board(body); await doing(name, 'reset', '复位中', caller.holder, body, signal => lab.relay.reset(name, who(caller.holder, body), signal)) } },
    { method: 'POST', path: '/api/fastboot', about: '进下载模式', handle: async ({ body, caller }) => { const name = board(body); await doing(name, 'fastboot', '进下载模式中', caller.holder, body, signal => lab.relay.fastboot(name, who(caller.holder, body), signal)) } },
    { method: 'GET', path: '/api/relay', about: '板子的继电器和按钮（后端能单独控制时）', handle: ({ query }) => lab.relay.channels(named(query.get('board'))) },
    {
      method: 'POST', path: '/api/relay', about: '控制板子的一个继电器或按钮：on、off、toggle、pulse、press、release、click（要拿锁）',
      handle: async ({ body, caller }) => ({ message: await lab.relay.setChannel(board(body), who(caller.holder, body), { channel: required(body.channel, 'channel'), action: required(body.action, 'action') as ChannelAction, ms: typeof body.ms === 'number' ? body.ms : null }) }),
    },
    { method: 'POST', path: '/api/confirm', about: '告诉后端，等人做的事做完了', handle: async ({ body, caller }) => ({ message: await lab.relay.confirm(board(body), caller.holder, typeof body.note === 'string' ? body.note : '') }) },

    // ---------- consoles ----------
    {
      method: 'GET', path: '/api/console', about: '看串口：先给最近的输出，再实时推送（raw=1 保留转义序列）', handle: async ({ query }) => {
        const session = await lab.consoles.open(named(query.get('board')), query.get('die') ?? undefined)
        const clean = query.get('raw') === '1' ? (text: string) => text : stripAnsi
        return new EventStream((emit, end, signal) => {
          // A long boot log (the last ~8 MB of it) is there when the console opens, not just the last few hundred lines.
          emit('history', recent(session.history, 8 * 1024 * 1024).map(clean))
          const decoder = new TextDecoder()
          session.onOutput(data => emit('output', clean(decoder.decode(data, { stream: true }))))
          session.onClose(reason => { emit('closed', reason); end() })
          signal.addEventListener('abort', () => session.close(), { once: true })
        })
      },
    },
    { method: 'GET', path: '/api/consoles', about: '开着的串口会话', handle: () => lab.consoles.reap() },
    {
      method: 'GET', path: '/api/logs', about: '串口日志：一段时间里的行（since、until：YYYY-MM-DD HH:MM:SS），可搜索（grep，regex=1），download=1 作为文件下载',
      handle: async ({ query }) => {
        const board = named(query.get('board'))
        const stamp = (key: string) => { const value = query.get(key); if (value && !/^\d{4}-\d\d-\d\d( \d\d:\d\d(:\d\d)?)?$/.test(value)) throw new BoardError('invalid', `${key} 要写成 YYYY-MM-DD HH:MM:SS`); return value }
        const result = await lab.consoles.logs(board, query.get('die') ?? undefined, {
          since: stamp('since'), until: stamp('until'), grep: query.get('grep') || null, regex: query.get('regex') === '1',
          limit: Number(query.get('limit') ?? (query.get('download') === '1' ? 200000 : 2000)), first: query.get('first') === '1',
        })
        if (query.get('download') !== '1') return result
        const span = [query.get('since'), query.get('until')].map(value => value?.replace(/[^0-9]/g, '').slice(0, 12) ?? '').filter(Boolean).join('-')
        return new TextReply(result.lines.join('\n') + '\n', 'text/plain; charset=utf-8', `${board}${span ? `-${span}` : ''}.log`)
      },
    },
    { method: 'GET', path: '/api/log', about: '串口最近的输出', handle: async ({ query }) => ({ lines: (await lab.consoles.log(named(query.get('board')), query.get('die') ?? undefined, Number(query.get('lines') ?? 200))).map(stripAnsi) }) },
    { method: 'POST', path: '/api/console/input', about: '往串口打字（人可以不拿锁：human）', handle: async ({ body, caller }) => { await lab.consoles.input(board(body), who(caller.holder, body), { die: body.die, data: String(body.data ?? ''), human: body.human === true }) } },
    { method: 'POST', path: '/api/send', about: '往串口发一行，可以等某个输出', handle: ({ body, caller }) => lab.consoles.send(board(body), who(caller.holder, body), { die: body.die, text: String(body.text ?? ''), newline: body.newline, wait: body.wait, timeoutMs: body.timeoutMs }) },

    // ---------- download ----------
    { method: 'POST', path: '/api/stage', about: '往内存加载 boardd 自带的固件', handle: async ({ body, caller }) => { const name = board(body); return { output: await doing(name, 'stage', '加载固件中', caller.holder, body, () => lab.download.stage(name, who(caller.holder, body), { die: body.die, firmware: required(body.firmware, 'firmware') }), true) } } },
    {
      method: 'POST', path: '/api/boot', about: '按顺序加载文件，从内存启动', handle: async ({ body, caller }) => {
        if (!Array.isArray(body.files) || body.files.some((file: unknown) => typeof file !== 'string')) throw new BoardError('invalid', 'files 要是文件路径数组')
        const name = board(body)
        return { output: await doing(name, 'boot', '启动中', caller.holder, body, () => lab.download.boot(name, who(caller.holder, body), { die: body.die, files: body.files }), true) }
      },
    },
    {
      method: 'POST', path: '/api/board/cancel', about: '让板子上正在做的启动或刷机停下（要拿锁）：它在下一步之前结束',
      handle: async ({ body, caller }) => {
        const name = board(body)
        const busy = lab.kernel.busy.get(name)
        if (busy && (busy.kind === 'discover' || busy.kind === 'rebuild')) {
          throw new BoardError('conflict', `${name} 正在${busy.label.replace(/中$/, '')}（实验室的操作，没有单独的锁）：到实验室那一栏取消发现，或者等它结束`)
        }
        lab.locks.authorize(name, who(caller.holder, body))
        if (!busy) throw new BoardError('conflict', `${name} 没有在启动或刷机，不用取消`)
        const route = lab.backends.route(name)
        if (!route.backend.cancel) throw new BoardError('invalid', `${name} 所在的后端不能取消`)
        return { message: await lab.kernel.doing([name], 'cancel', '取消中', caller.holder, () => route.backend.cancel!(route.config, route.target)) }
      },
    },
    {
      method: 'GET', path: '/api/boot/breaks', about: '一个 SDK 的启动流程可以在哪停下（recipe 里的 breaker），调试 U-Boot、内核时用',
      handle: ({ query }) => {
        const name = named(query.get('board')), sdk = required(query.get('sdk'), 'sdk')
        const route = lab.backends.route(name), breaks = route.backend.builds?.breaks
        if (!breaks) return { load: [], download: [] }
        return breaks(route.config, sdk)
      },
    },
    { method: 'POST', path: '/api/boot/sdk', about: '用 SDK 的构建启动（load）或刷机（download）', handle: async ({ body, caller }) => {
        const name = board(body), method = body.method === 'download' ? 'download' : 'load'
        return { output: await doing(name, 'boot', method === 'download' ? '刷机中' : '启动中', caller.holder, body, () => lab.download.build(name, who(caller.holder, body), { sdk: required(body.sdk, 'sdk'), method, variant: optional(body.variant), brk: optional(body.brk) }), true) }
      },
    },
    {
      method: 'POST', path: '/api/flash/package', about: '用刷机包刷机：url（http/https，后端自己下载）或传上来的文件（sha256），flasher 选刷机工具', handle: async ({ body, caller }) => {
        const name = board(body)
        const input = { url: optional(body.url), sha256: optional(body.sha256), flasher: optional(body.flasher) }
        return { output: await doing(name, 'boot', '刷机中', caller.holder, body, (signal, line) => lab.download.flashPackage(name, who(caller.holder, body), input, signal, line), true) }
      },
    },

    // ---------- files ----------
    {
      method: 'GET', path: '/api/files/:sha256', about: 'boardd 有没有这个文件（download=1 取回内容）', handle: ({ params, query }) => {
        if (query.get('download') === '1') {
          const file = lab.files.get(params.sha256!)
          if (!file) throw new BoardError('not-found', '没有这个文件')
          return new FileReply(file.path)
        }
        return { sha256: params.sha256, present: !!lab.files.get(params.sha256!) }
      },
    },
    { method: 'PUT', path: '/api/files/:sha256', about: '传文件，按 sha256 校验和保存（name= 文件名）', handle: ({ params, query, caller, upload }) => lab.files.put(caller.holder, params.sha256!, query.get('name') ?? 'file', upload!) },

    // ---------- inventory ----------
    { method: 'POST', path: '/api/boards/add', about: '手工登记板子', handle: ({ body, caller }) => { lab.boards.add(caller.holder, body) } },
    { method: 'POST', path: '/api/boards/remove', about: '移除板子', handle: async ({ body, caller }) => { const name = named(body.name, 'name'); await lab.kernel.doing([lab.boards.free(name)], 'remove', '移除中', caller.holder, () => lab.boards.remove(caller.holder, name)) } },
    {
      method: 'POST', path: '/api/board', about: '改板子的备注、槽位或型号（product 为空则清掉；填过的型号会记下来，下次出现在下拉列表里）',
      handle: ({ body, caller }) => {
        const patch: { notes?: string | null, slot?: number | null, product?: string | null } = { notes: body.notes, slot: body.slot }
        if ('product' in body) patch.product = body.product === null ? null : String(body.product)
        lab.boards.update(caller.holder, named(body.name, 'name'), patch)
      },
    },
    {
      method: 'POST', path: '/api/board/rename', about: '给板子改名（全链路：板子、串口名、锁、队列、历史和它所在实验室的名字一起改；要拿着锁或板子空闲时）',
      handle: ({ body, caller }) => lab.backends.rename(caller.holder, named(body.board, 'board'), required(body.name, 'name'), {
        holder: caller.holder, token: typeof body.token === 'string' ? body.token : null,
      }),
    },
    { method: 'GET', path: '/api/models', about: '人们自己填过的板子型号，最近用的在前（给下拉列表）', handle: () => ({ models: lab.boards.models() }) },
    { method: 'POST', path: '/api/boards/refresh', about: '槽位里换了板子以后重新读取它（要拿锁；name 改名，rename 按读到的改名）', handle: ({ body, caller }) => { const name = board(body); return doing(name, 'refresh', '读取中', caller.holder, body, signal => lab.backends.refresh(name, who(caller.holder, body), { name: optional(body.name), rename: body.rename === true }, signal)) } },
    { method: 'POST', path: '/api/proposals', about: '应用或拒绝改动建议', handle: async ({ body, caller }) => { await lab.proposals.resolve(caller.holder, body.ids ?? [], body.decision === 'apply' ? 'apply' : 'reject', body.names && typeof body.names === 'object' ? body.names : {}) } },

    // ---------- backends ----------
    {
      method: 'POST', path: '/api/labs', about: '设置实验室并开关', handle: ({ body, caller }) => lab.backends.configure(caller.holder, required(body.id, 'id'), {
        enabled: body.enabled === true, url: optional(body.url), username: optional(body.username), password: optional(body.password), jump: optional(body.jump), devices: optional(body.devices),
      }),
    },
    { method: 'GET', path: '/api/labs/kinds', about: '可以添加的实验室种类（模块提供）', handle: () => lab.backends.kindsOffered() },
    { method: 'POST', path: '/api/labs/add', about: '添加一个实验室（id、kind），添加后由它的模块设置', handle: ({ body, caller }) => lab.backends.add(caller.holder, required(body.id, 'id'), required(body.kind, 'kind')) },
    { method: 'POST', path: '/api/labs/remove', about: '删除一个添加的实验室（id）：它的板子一起去掉，不能有人拿着锁', handle: async ({ body, caller }) => { await lab.backends.removeLab(caller.holder, required(body.id, 'id')); return { ok: true } } },
    { method: 'POST', path: '/api/labs/test', about: '检查实验室的访问并重新列板子', handle: ({ body, caller }) => lab.backends.test(caller.holder, required(body.id, 'id')) },
    { method: 'GET', path: '/api/labs/slots', about: '实验室的空闲端口（fresh=1 等最新的）', handle: ({ query }) => lab.backends.ports(required(query.get('id'), 'id'), { fresh: query.get('fresh') === '1' }) },
    { method: 'POST', path: '/api/labs/bind', about: '用空闲端口登记板子', handle: async ({ body, caller }) => ({ board: await lab.backends.bind(caller.holder, required(body.id, 'id'), { host: required(body.host, 'host'), console: required(body.console, 'console'), usb: required(body.usb, 'usb'), name: optional(body.name) }) }) },
    {
      method: 'POST', path: '/api/labs/discover', about: '让实验室发现新板子（slots：只发现这些槽位）', handle: ({ body, caller }) => {
        const slots = Array.isArray(body.slots) ? body.slots.map(String) : typeof body.slots === 'string' && body.slots ? body.slots.split(',') : []
        // The page sends what the person typed; the CLI sends numbers. Both end up as header GPIO numbers.
        const prefer = typeof body.prefer === 'string' ? pinNumbers(body.prefer)
          : Array.isArray(body.prefer) ? body.prefer.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 999) : []
        if (typeof body.prefer === 'string' && body.prefer.trim() && !prefer.length) throw new BoardError('invalid', `没有认出要优先试的 GPIO：${body.prefer}（写成 12,13、GPIO12、gpio_13 都可以）`)
        return lab.backends.discover(caller.holder, required(body.id, 'id'), body.confirmed === true, { human: body.human === true, host: optional(body.host), slots, prefer })
      },
    },
    { method: 'POST', path: '/api/labs/discover/cancel', about: '让正在进行的发现或重建停下（id）：已经登记的和正在跑的那一步会留着', handle: ({ body, caller }) => lab.backends.cancelDiscovery(caller.holder, required(body.id, 'id')) },
    { method: 'POST', path: '/api/labs/rebuild', about: '重新布线以后，让实验室重建一台主机：忘掉它的板子，按现在的接线重新发现；keepInUse 只重做变动的，保留在用的板子', handle: ({ body, caller }) => lab.backends.rebuild(caller.holder, required(body.id, 'id'), body.confirmed === true, required(body.host, 'host'), body.keepInUse === true) },
  ]
}
