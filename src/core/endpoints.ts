/** The endpoints of the core: state, locks, the relay, consoles, download, files, inventory, backends and proposals. */
import type { BoardEvent } from '../shared/types.ts'
import { stops, type CancellableOperation, type ChannelAction } from './backend.ts'
import { EventStream, FileReply, optional, required, TextReply, type Endpoint } from './api.ts'
import { BoardError } from './errors.ts'
import type { RunContext } from './kernel.ts'
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
  // is not stopped halfway by the lock ending: the board stays busy until it ends, so the next holder sees it is still
  // being written. Either can be cancelled (`POST /api/cancel`) when the board's backend says it stops that operation
  // (`operation`), or always, when boardd runs it step by step itself (`true`). `line` shows a progress line on the
  // board while it runs.
  const doing = <T>(name: string, kind: string, label: string, holder: string, body: any, run: (signal: AbortSignal, line: (text: string) => void, context: RunContext) => Promise<T>,
    untilDone = false, operation: CancellableOperation | boolean = false) => {
    const lease = lab.locks.authorize(name, who(holder, body))
    const cancellable = typeof operation === 'boolean' ? operation : stops(lab.backends.route(name).backend, operation)
    return lab.kernel.doing([name], kind, label, holder, (line, signal, context) => run(signal, line, context), { lease: untilDone ? null : lease.id, cancellable })
  }
  /**
   * Stop what boardd is doing to a board or a lab (`lab:<id>`), whatever it is: a lab's discovery, or a run on the
   * board or lab that its backend can stop. A board someone holds is cancelled by its holder only; what runs on a free
   * board (a lab's search, a flash whose lock was given back) by anyone. A board boardd runs nothing on, but whose
   * backend may still be running something of its own, is handed to the backend's `cancel`. A cancel the backend
   * refused is an error, never an answer that it stops.
   */
  const cancel = async (target: string, holder: string, body: any): Promise<{ message: string, cancelled: true }> => {
    const lab_ = target.match(/^lab:(.+)$/)?.[1]
    if (lab_ && lab.backends.discovering(lab_)) return { ...(await lab.backends.cancelDiscovery(holder, lab_)), cancelled: true }
    const name = lab_ ? target : lab.boards.resolve(target)
    if (!lab_ && lab.locks.held(name)) lab.locks.authorize(name, who(holder, body))
    const own = lab.kernel.busy.has(name)
    const other = own ? null : lab.kernel.occupied(name)
    // A run a worker being replaced still runs is stopped through its backend when it can be: that worker sees it end.
    const forward = !!other && other.cancellable && !lab_ && !!lab.backends.route(name).backend.cancel
    if (own || (other && !forward)) {
      const asked = lab.kernel.cancel(name, holder)
      // A backend that refused to stop says why; the run goes on, and the board stays busy until it ends.
      try { await asked.answered }
      catch (error) { throw new BoardError('hardware', `${name} 没有停下：${(error as Error).message}（它还在做，做完板子才空出来）`) }
      return { message: asked.message, cancelled: true }
    }
    const elsewhere = forward ? null : lab.kernel.cancelElsewhere(name, holder)
    if (elsewhere) return { message: elsewhere, cancelled: true }
    if (lab_) throw new BoardError('conflict', `实验室 ${lab_} 没有在做什么，不用取消`)
    const route = lab.backends.route(name)
    if (!route.backend.cancel) throw new BoardError('conflict', `${name} 没有在做什么，不用取消`)
    lab.locks.authorize(name, who(holder, body))
    let message: string
    try { message = await route.backend.cancel(route.config, route.target) }
    catch (error) {
      lab.kernel.record(holder, name, 'cancel', null, false, (error as Error).message)
      // A backend that answers with a BoardError says what kind of answer it is (nothing to cancel is a conflict,
      // not a board that would not stop): it stands as given.
      if (error instanceof BoardError) throw error
      throw new BoardError('hardware', `${name} 没有停下：${(error as Error).message}`)
    }
    lab.kernel.record(holder, name, 'cancel', null, true, message)
    return { message, cancelled: true }
  }
  return [
    { method: 'GET', path: '/api', about: '列出所有接口和模块', handle: () => ({ endpoints: lab.api.list().map(item => `${item.method} ${item.path}`), described: lab.api.list(), modules: lab.modules() }) },
    { method: 'GET', path: '/api/modules', about: '装了哪些模块', handle: () => lab.modules() },
    { method: 'GET', path: '/api/state', about: '全貌：板子、锁、后端、建议，和各模块的部分', handle: ({ caller }) => lab.state(caller.holder) },
    { method: 'GET', path: '/api/board', about: '一块板子的详情和最近的操作', handle: ({ query }) => lab.boards.detail(named(query.get('name'), 'name')) },
    {
      method: 'GET', path: '/api/run', about: '一次运行（刷机、启动……）现在怎样了：断线的客户端按编号跟到它结束',
      handle: ({ query }) => {
        const run = lab.kernel.runs.get(required(query.get('id'), 'id'))
        if (!run) throw new BoardError('not-found', `没有这次运行：${query.get('id')}`)
        const { handle: _handle, boot: _boot, pid: _pid, cancellable: _cancellable, ...shown } = run
        return shown
      },
    },
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
    { method: 'GET', path: '/api/yields', about: 'AI 在等你让出的板子（只列出你能回答的：你拿着锁的那些）', handle: ({ caller }) => lab.locks.yieldsList(caller.holder) },
    {
      method: 'POST', path: '/api/yields', about: '回答 AI 的让出请求：board、action=yield（让出）或 deny（继续用）；只有拿锁的人能答',
      handle: ({ body, caller }) => {
        if (body.action !== 'yield' && body.action !== 'deny') throw new BoardError('invalid', 'action 只能是 yield 或 deny')
        return { message: lab.locks.answerYield(board(body), caller.holder, body.action) }
      },
    },
    { method: 'POST', path: '/api/unqueue', about: '离开队列', handle: ({ body, caller }) => { lab.locks.unqueue(board(body), caller.holder) } },
    { method: 'POST', path: '/api/steal', about: '抢锁（只有人可以，要写原因）', handle: ({ body, caller }) => lab.locks.steal(board(body), caller.holder, String(body.reason ?? '')) },

    // ---------- relay ----------
    { method: 'POST', path: '/api/reset', about: '复位', handle: async ({ body, caller }) => { const name = board(body); await doing(name, 'reset', '复位中', caller.holder, body, signal => lab.relay.reset(name, who(caller.holder, body), signal), false, 'reset') } },
    { method: 'POST', path: '/api/fastboot', about: '进下载模式', handle: async ({ body, caller }) => { const name = board(body); await doing(name, 'fastboot', '进下载模式中', caller.holder, body, signal => lab.relay.fastboot(name, who(caller.holder, body), signal), false, 'download') } },
    { method: 'GET', path: '/api/relay', about: '板子的继电器和按钮（后端能单独控制时）', handle: ({ query }) => lab.relay.channels(named(query.get('board'))) },
    {
      method: 'POST', path: '/api/relay', about: '控制板子的一个继电器或按钮：on、off、toggle、pulse、press、release、click（要拿锁）',
      handle: async ({ body, caller }) => ({ message: await lab.relay.setChannel(board(body), who(caller.holder, body), { channel: required(body.channel, 'channel'), action: required(body.action, 'action') as ChannelAction, ms: typeof body.ms === 'number' ? body.ms : null }) }),
    },
    { method: 'POST', path: '/api/confirm', about: '告诉后端，等人做的事做完了（request：页面上的请求 id，重复确认不报错）', handle: async ({ body, caller }) => ({ message: await lab.relay.confirm(board(body), caller.holder, typeof body.note === 'string' ? body.note : '', typeof body.request === 'string' && body.request ? body.request : null) }) },

    // ---------- consoles ----------
    {
      method: 'GET', path: '/api/console', about: '看串口：先给最近的输出，再实时推送（raw=1 保留转义序列）；打不开时，事件流的请求收到 closed 和原因', handle: async ({ query, headers }) => {
        const name = named(query.get('board'))
        let session: Awaited<ReturnType<typeof lab.consoles.open>>
        try { session = await lab.consoles.open(name, query.get('die') ?? undefined) }
        catch (error) {
          // A browser's EventSource cannot read an error reply, only events: it is told why in the stream it asked for.
          if (!String(headers?.accept ?? '').includes('text/event-stream')) throw error
          return new EventStream((emit, end) => { emit('closed', (error as Error).message); end() })
        }
        const clean = query.get('raw') === '1' ? (text: string) => text : stripAnsi
        return new EventStream((emit, end, signal) => {
          // Which boardd process serves it: a viewer that reconnects to another one knows boardd restarted.
          emit('hello', { boot: lab.kernel.boot })
          // A long boot log (the last ~8 MB of it) is there when the console opens, not just the last few hundred lines.
          emit('history', recent(session.history, 8 * 1024 * 1024).map(clean))
          const decoder = new TextDecoder()
          session.onOutput(data => emit('output', clean(decoder.decode(data, { stream: true }))))
          session.onClose(reason => { emit('closed', reason); end() })
          // boardd itself stopping is not the port closing: it says so in an event of its own.
          const stopping = (reason: string) => { emit('restart', { reason }); end() }
          lab.consoles.onShutdown(stopping)
          signal.addEventListener('abort', () => { lab.consoles.offShutdown(stopping); session.close() }, { once: true })
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
    { method: 'POST', path: '/api/stage', about: '往内存加载 boardd 自带的固件', handle: async ({ body, caller }) => { const name = board(body); return { output: await doing(name, 'stage', '加载固件中', caller.holder, body, signal => lab.download.stage(name, who(caller.holder, body), { die: body.die, firmware: required(body.firmware, 'firmware') }, signal), true, 'stage') } } },
    {
      method: 'POST', path: '/api/boot', about: '按顺序加载文件，从内存启动', handle: async ({ body, caller }) => {
        if (!Array.isArray(body.files) || body.files.some((file: unknown) => typeof file !== 'string')) throw new BoardError('invalid', 'files 要是文件路径数组')
        const name = board(body)
        // A backend that runs the whole boot itself stops it if it says so; boardd's own file-by-file boot stops between files.
        const operation = lab.backends.route(name).backend.download.boot ? 'boot' as const : true
        return { output: await doing(name, 'boot', '启动中', caller.holder, body, signal => lab.download.boot(name, who(caller.holder, body), { die: body.die, files: body.files }, signal), true, operation) }
      },
    },
    {
      method: 'POST', path: '/api/cancel', about: '让正在做的操作停下：target 是板子（要拿锁，板子有锁时）或 lab:<实验室>；它在正在做的那一步结束后停下，回答 cancelled',
      handle: ({ body, caller }) => cancel(required(body.target, 'target'), caller.holder, body),
    },
    {
      method: 'POST', path: '/api/board/cancel', about: '同 /api/cancel，target 是 board',
      handle: ({ body, caller }) => cancel(required(body.board, 'board'), caller.holder, body),
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
        return { output: await doing(name, 'boot', method === 'download' ? '刷机中' : '启动中', caller.holder, body, (signal, line, context) => lab.download.build(name, who(caller.holder, body), { sdk: required(body.sdk, 'sdk'), method, variant: optional(body.variant), brk: optional(body.brk) }, signal, line, context), true, 'build') }
      },
    },
    {
      method: 'POST', path: '/api/flash/package', about: '用刷机包刷机：镜像市场里的镜像（image: {market, path}）、链接（url，后端自己取，板子上的 packages 说它收哪些）或传上来的文件（sha256），flasher 选刷机工具，refresh 让后端不用它缓存的这个链接、重新下载', handle: async ({ body, caller }) => {
        const name = board(body)
        const image = body.image && typeof body.image === 'object' ? { market: required(body.image.market, 'image.market'), path: required(body.image.path, 'image.path') } : null
        const input = { url: optional(body.url), sha256: optional(body.sha256), image, flasher: optional(body.flasher), refresh: body.refresh === true }
        return { output: await doing(name, 'boot', '刷机中', caller.holder, body, (signal, line, context) => lab.download.flashPackage(name, who(caller.holder, body), input, signal, line, context), true, 'flash') }
      },
    },

    // ---------- files ----------
    {
      method: 'GET', path: '/api/files/:sha256', about: 'boardd 有没有这个文件（download=1 取回内容；没收完的给 received，从那里续传）', handle: ({ params, query }) => {
        if (query.get('download') === '1') {
          const file = lab.files.get(params.sha256!)
          if (!file) throw new BoardError('not-found', '没有这个文件')
          return new FileReply(file.path)
        }
        const partial = lab.files.partial(params.sha256!)
        return { sha256: params.sha256, present: !!lab.files.get(params.sha256!), ...(partial ? { received: partial.received } : {}) }
      },
    },
    {
      // Deliberately disabled: a large request body crashes Node on RISC-V (the K1/K3 boardd builds). Clients copy
      // with scp to a ticket path instead; see /api/files/ticket.
      method: 'PUT', path: '/api/files/:sha256', about: '已禁用：网页上传在 RISC-V 上的 Node 有崩溃缺陷；客户端改用 scp（见 /api/files/ticket）',
      handle: () => { throw new BoardError('forbidden', '网页上传已禁用：请用 boardlab CLI（scp 传输），或给板子所在主机一个 http(s) 链接') },
    },
    {
      method: 'POST', path: '/api/files/ticket', about: '给 scp 一个上传路径：客户端把文件直接复制到那个路径，再调 /api/files/adopt；大文件不经 boardd 的请求体',
      handle: ({ body }) => lab.files.ticket(required(body.sha256, 'sha256'), typeof body.name === 'string' ? body.name : 'file'),
    },
    {
      method: 'POST', path: '/api/files/adopt', about: '校验客户端 scp 到上传路径的文件（id、sha256、name），通过后按 sha256 存下',
      handle: ({ body, caller }) => lab.files.adopt(caller.holder, required(body.id, 'id'), required(body.sha256, 'sha256'), typeof body.name === 'string' ? body.name : 'file'),
    },

    // ---------- inventory ----------
    { method: 'POST', path: '/api/boards/add', about: '手工登记板子', handle: ({ body, caller }) => { lab.boards.add(caller.holder, body) } },
    { method: 'POST', path: '/api/boards/remove', about: '移除板子', handle: async ({ body, caller }) => { const name = named(body.name, 'name'); await lab.kernel.doing([lab.boards.free(name)], 'remove', '移除中', caller.holder, () => lab.boards.remove(caller.holder, name)) } },
    {
      method: 'POST', path: '/api/board', about: '改板子的备注、槽位或型号（product 为空则清掉；填过的型号会记下来，下次出现在下拉列表里）',
      handle: ({ body, caller }) => {
        const patch: { notes?: string | null, slot?: number | null, product?: string | null, soc?: string | null } = { notes: body.notes, slot: body.slot }
        if ('product' in body) patch.product = body.product === null ? null : String(body.product)
        if ('soc' in body) patch.soc = body.soc === null ? null : String(body.soc)
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
    { method: 'POST', path: '/api/boards/refresh', about: '槽位里换了板子以后重新读取它（要拿锁；name 改名，rename 按读到的改名）', handle: ({ body, caller }) => { const name = board(body); return doing(name, 'refresh', '读取中', caller.holder, body, signal => lab.backends.refresh(name, who(caller.holder, body), { name: optional(body.name), rename: body.rename === true }, signal), false, 'refresh') } },
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
    {
      method: 'GET', path: '/api/labs/discover/methods', about: '实验室后端上报的发现方法（id、标题、说明、字段），可带 host/slot 取该主机或槽位的选项', handle: ({ query }) =>
        lab.backends.discoveryMethods(required(query.get('id'), 'id'), { host: optional(query.get('host')), slot: optional(query.get('slot')) }),
    },
    {
      method: 'POST', path: '/api/labs/discover', about: '用一个后端上报的发现方法找板子：method、values，可带 host/slot', handle: ({ body, caller }) => {
        const values = body.values && typeof body.values === 'object' && !Array.isArray(body.values)
          ? Object.fromEntries(Object.entries(body.values).map(([key, value]) => [key, String(value)])) : {}
        return lab.backends.discover(caller.holder, required(body.id, 'id'), body.confirmed === true, {
          method: required(body.method, 'method'), values, host: optional(body.host), slot: optional(body.slot),
        })
      },
    },
    {
      method: 'POST', path: '/api/labs/compose', about: '手工登记一块扫不到的板子（后端的 compose 方法：method、values、可选 host/slot）：比如只有 GPIO 调试口的板子', handle: ({ body, caller }) => {
        const values = body.values && typeof body.values === 'object' && !Array.isArray(body.values)
          ? Object.fromEntries(Object.entries(body.values).map(([key, value]) => [key, String(value)])) : {}
        return lab.backends.compose(caller.holder, required(body.id, 'id'), {
          method: required(body.method, 'method'), values, host: optional(body.host), slot: optional(body.slot),
        })
      },
    },
    { method: 'POST', path: '/api/labs/discover/cancel', about: '让正在进行的发现或重建停下（id）：已经登记的和正在跑的那一步会留着', handle: ({ body, caller }) => lab.backends.cancelDiscovery(caller.holder, required(body.id, 'id')) },
    { method: 'POST', path: '/api/labs/rebuild', about: '重新布线以后，让实验室重建一台主机：忘掉它的板子，按现在的接线重新发现；keepInUse 只重做变动的，保留在用的板子', handle: ({ body, caller }) => lab.backends.rebuild(caller.holder, required(body.id, 'id'), body.confirmed === true, required(body.host, 'host'), body.keepInUse === true) },
  ]
}
