/** Commands on boards, whatever backend they are on: the list, locks, the relay, consoles, loading and the inventory. */
import { resolve } from 'node:path'
import type { Board, State } from '../../shared/types.ts'
import { parseDuration, type Command, type CommandGroup } from '../command.ts'
import { pickConsole, streamConsole } from '../console.ts'

/** While the lock is held only this token gets input past the board's input gate. */
function gateHint(gateToken: string | null) {
  if (gateToken) console.log(`直接用 smtty 输入时带上 --token ${gateToken}（或设 SERIAL_MUX_TOKEN）；不带的只能看输出`)
}

function leaseText(board: Board) {
  const queue = board.waiters.length ? `；排队：${board.waiters.map((waiter, index) => `${index + 1}. ${waiter.holder}`).join(' ')}` : ''
  const busy = board.busy ? `；${board.busy.label}（${board.busy.by}）${board.busy.line ? `：${board.busy.line}` : ''}` : ''
  return (board.lease ? `${board.lease.holder} 使用中（${board.lease.purpose}）` : '空闲') + busy + queue
}

export function printBoards(boards: Board[]) {
  for (const board of boards) {
    const place = board.lab ? `[实验室 ${board.lab.id} ${board.lab.empty ? '空槽位' : board.lab.device}]` : board.slot === null ? '  -' : `[${board.slot}]`
    const slot = board.lab && board.slotRef ? `  槽位 ${board.slotRef.split('/').slice(1).join('/')}` : ''
    const media = board.lab?.mediaBoot && board.lab.mediaBoot.method !== 'reset'
      ? `  复位：${board.lab.mediaBoot.available ? `经 ${board.lab.mediaBoot.method} 从介质启动` : '停在下载模式'}` : ''
    console.log(`${place} ${board.name}  ${board.lab?.empty ? '还没有登记板子，只有串口' : board.product ?? '型号未知'}${slot}${media}  ${leaseText(board)}`)
    for (const chip of board.chips) {
      if (board.lab) { console.log(`      ${chip.die}: 串口 ${chip.serialPath ?? '-'}（实验室那边${chip.online ? '在线' : '没有连上'}）  下载口 ${chip.downloadUsbPath ?? '-'}`); continue }
      console.log(`      ${chip.die}: 串口 ${chip.serialPath ?? '-'}${chip.alias ? `（serial-mux ${chip.alias}${chip.online ? '' : '，未绑定设备'}）` : ''}  下载口 ${chip.downloadUsbPath ?? '-'}${chip.usbId ? ` (${chip.usbId})` : ''}`)
    }
  }
}

function printState(state: State) {
  printBoards(state.boards)
  const empty = (state.slots ?? []).filter(slot => !state.boards.some(board => board.slot === slot.slot))
  for (const slot of empty) console.log(`[${slot.slot}] （空槽位）`)
  if (state.proposals.length) console.log(`\n${state.proposals.length} 条扫描改动建议待确认：boardlab proposals`)
}

const commands: Command[] = [
  {
    name: 'list', usage: ['list\t板子、芯片、槽位和锁'],
    async run({ client, out }) { const state = await client.state(); out(state, () => printState(state)) },
  },
  {
    name: 'show', usage: ['show <board>\t详情、最近的操作和锁记录'],
    async run({ client, out, target }) {
      const detail = await client.board(target().board)
      out(detail, () => {
        printBoards([detail.board])
        if (detail.board.notes) console.log(`\n备注：\n${detail.board.notes}`)
        console.log('\n最近操作：')
        for (const action of detail.actions.slice(0, 15)) console.log(`  ${action.at}  ${action.actor}  ${action.kind}${action.detail ? ` ${action.detail}` : ''}${action.ok ? '' : `  失败：${action.message}`}`)
      })
    },
  },
  {
    name: 'lock', usage: ['lock <board> --for <用途> [--wait]\t锁没有时间限制；--wait 排队直到拿到'],
    async run({ client, flag, flags, json, out, target, keepToken }) {
      const purpose = flag('for')
      if (!purpose) throw new Error('请用 --for 写明用途')
      const { board } = target()
      if (flags.has('wait') && !json) console.error(`排队等待 ${board} …`)
      const abort = new AbortController()
      process.once('SIGINT', () => abort.abort())
      const result = await client.lock(board, purpose, flags.has('wait') ? 'wait' : 'none', abort.signal)
      keepToken(board, result.token)
      out(result, () => { console.log(`已拿到 ${board} 的锁，用完请 boardlab unlock ${board}`); gateHint(result.gateToken) })
    },
  },
  {
    name: 'queue', usage: ['queue <board> --for <用途>\t加入排队，先到先得；轮到你时自动拿到锁'],
    async run({ client, flag, out, target, keepToken }) {
      const purpose = flag('for')
      if (!purpose) throw new Error('请用 --for 写明用途')
      const { board } = target()
      const result = await client.lock(board, purpose, 'join')
      if (result.token) keepToken(board, result.token)
      out(result, () => { console.log(result.lease ? `${board} 空闲，已直接拿到锁` : `已排队，第 ${result.queued!.position} 位；轮到你时自动拿到锁，再运行 boardlab lock 取凭证`); gateHint(result.gateToken) })
    },
  },
  {
    name: 'unqueue', usage: ['unqueue <board> | unlock <board>'],
    async run({ client, out, target }) { await client.unqueue(target().board); out({ ok: true }, () => console.log(`已退出 ${target().board} 的排队`)) },
  },
  {
    name: 'unlock', usage: [],
    async run({ client, out, target, token, keepToken }) {
      const { board } = target()
      await client.unlock(board, token())
      keepToken(board, null)
      out({ ok: true }, () => console.log(`已释放 ${board}`))
    },
  },
  {
    name: 'steal', usage: ['steal <board> --reason <原因>\t仅限人'],
    async run({ client, flag, out, target, keepToken }) {
      const reason = flag('reason')
      if (!reason) throw new Error('抢锁要用 --reason 写明原因')
      const { board } = target()
      const result = await client.steal(board, reason)
      keepToken(board, result.token)
      out(result, () => { console.log(`已抢到 ${board} 的锁`); gateHint(result.gateToken) })
    },
  },
  {
    name: 'reset', usage: ['reset <board> | fastboot <board>\t需要持有锁'],
    async run({ client, out, target, token }) { await client.reset(target().board, token()); out({ ok: true }, () => console.log(`${target().board} 已复位`)) },
  },
  {
    name: 'fastboot', usage: [],
    async run({ client, out, target, token }) { await client.fastboot(target().board, token()); out({ ok: true }, () => console.log(`${target().board} 已进入 fastboot`)) },
  },
  {
    name: 'relay',
    usage: [
      'relay <board>\t板子的继电器和按钮（后端能单独控制它们时）',
      'relay <board> <通道> on|off|toggle|pulse|press|release|click [--ms <毫秒>]\t控制其中一个（要拿锁）；通道可以只写名字，例如 relay lab1-a power pulse --ms 2000',
    ],
    async run({ client, args, flag, out, target, token }) {
      const { board } = target()
      // Channels are named after the board as its backend knows it: `<device>/power`.
      const device = (await client.board(board)).board.lab?.device ?? board
      if (!args[1]) {
        const result = await client.channels(board)
        return out(result, () => {
          if (!result.supported) return console.log(`${board} 所在的后端不能单独控制继电器`)
          if (!result.channels.length) return console.log(`${board} 没有登记继电器或按钮（实验室里给 ${device}/<名字> 起别名就会列出来）`)
          for (const channel of result.channels) console.log(`${channel.id.padEnd(24)} ${channel.kind.padEnd(7)} ${(channel.state ?? '-').padEnd(8)} ${channel.actions.join(' ')}`)
        })
      }
      const action = args[2]
      if (!action) throw new Error('缺少动作：on、off、toggle、pulse、press、release、click')
      // A channel may be named by its role alone: `power` for `<device>/power`.
      const channel = args[1].includes('/') ? args[1] : `${device}/${args[1]}`
      const result = await client.setChannel(board, channel, action, flag('ms') ? Number(flag('ms')) : null, token())
      out(result, () => console.log(result.message))
    },
  },
  {
    name: 'refresh', usage: ['refresh <board|槽位> [--name <新名字> | --rename]\t槽位里换了板子以后重新读取它（型号、SoC、下载口），不用删了重加；要拿锁，锁跟着槽位走'],
    async run({ client, flag, flags, json, out, target, token }) {
      const { board } = target()
      if (!json) console.error(`${board}：复位进下载模式，重新读取板子…`)
      const result = await client.refresh(board, { name: flag('name'), rename: flags.has('rename') }, token())
      out(result, () => console.log(`${result.message}${result.board !== board ? `\n现在叫 ${result.board}，锁还在你手里` : ''}`))
    },
  },
  {
    name: 'confirm', usage: ['confirm <board> [<备注>]\t由人复位的板子：照提示按了 RESET 之后告诉实验室（不需要锁）'],
    async run({ client, args, out, target }) { const result = await client.confirm(target().board, args.slice(1).join(' ')); out(result, () => console.log(result.message)) },
  },
  {
    name: 'console',
    usage: [
      'console <board>[.<die>] [--human]\t串口终端：拿着锁时可以直接输入（Ctrl-C 也发给板子），Ctrl-A Ctrl-X 退出（同 picocom）；--human：人在键盘前，不查锁直接输入（agent 不要用）',
      'console -i\t用方向键选串口，再确认是不是人',
    ],
    async run({ client, holder, args, flags, target, token }) {
      let picked = args[0] ? target() : null
      let human = flags.has('human')
      if (flags.has('interactive') || !picked) {
        const choice = await pickConsole(client, holder)
        if (!choice) return
        picked = choice.target
        human = choice.human
      }
      if (human && !holder.startsWith('user:')) throw new Error(`--human 只给人用；现在的身份是 ${holder}（agent 要先 boardlab lock）`)
      // People who locked the board on the page hold it by name, without a token here.
      const lease = (await client.board(picked.board)).board.lease
      return streamConsole(client, picked.board, picked.die, token(picked.board), lease?.holder === holder, human)
    },
  },
  {
    name: 'send', usage: ['send <board>[.<die>] <text> [--wait <正则>] [--timeout 10s] [--raw]'],
    async run({ client, args, flag, flags, out, target, token }) {
      const text = args[1]
      if (text === undefined) throw new Error('缺少要发送的内容')
      const { board, die } = target()
      const result = await client.send(board, { die, text, newline: !flags.has('raw'), wait: flag('wait'), timeoutMs: flag('timeout') ? parseDuration(flag('timeout')!) : undefined, token: token() })
      out(result, () => process.stdout.write(result.output + (result.output.endsWith('\n') ? '' : '\n')))
      if (flag('wait') && !result.matched) process.exitCode = 2
    },
  },
  {
    name: 'log', usage: ['log <board>[.<die>] [--lines 200]'],
    async run({ client, flag, out, target }) { const result = await client.log(target().board, target().die, Number(flag('lines') ?? 200)); out(result, () => console.log(result.lines.join('\n'))) },
  },
  {
    name: 'stage', usage: ['stage <board>[.<die>] <固件名>\t往内存加载 boardd 自带的固件，例如 minor-board-info'],
    async run({ client, args, out, target, token }) {
      if (!args[1]) throw new Error('缺少固件名，例如 minor-board-info')
      const result = await client.stage(target().board, args[1], target().die, token())
      out(result, () => console.log(result.output))
    },
  },
  {
    name: 'boot',
    usage: [
      'boot <board> --sdk <SDK> [--method load|download] [--variant V] [--break 名字]\t后端能取构建产物的板子用 SDK 的产物内存启动或刷机，板子所在主机自己去构建服务器取',
      'boot <board>[.<die>] <固件名|文件>...\t按顺序把 FSBL、U-Boot/OpenSBI、内核加载到内存启动，不写板子；只改内核时：boot <board> fsbl u-boot-opensbi <Image.itb>',
    ],
    run: context => boot(context, 'boot'),
  },
  {
    name: 'flash',
    usage: [
      'flash <board> <链接|文件> [--flasher <工具>]\t用刷机包刷机（要拿锁）：http(s) 链接由板子所在主机下载，本机的文件先传给 boardd；--flasher 选刷机工具',
      'flash <board> --sdk <SDK> [--variant V]\t用 SDK 的产物刷机，同 boot --sdk <SDK> --method download',
    ],
    run: context => boot(context, 'flash'),
  },
  {
    name: 'cancel',
    usage: ['cancel <board>\t让板子上正在做的启动或刷机停下（要拿锁）：它在下一步之前结束'],
    async run({ client, out, target, token }) {
      out(await client.cancelBoard(target().board, token()), () => `已让 ${target().board} 停下`)
    },
  },
  {
    name: 'proposals', usage: ['proposals [apply|reject] [<id>...|--all] [--name <板名>]\t扫描和发现找到的改动建议；只能复位的槽位上的新板子要用 --name 起名'],
    async run({ client, args, flag, flags, out }) {
      const state = await client.state()
      const decision = args[0]
      if (decision !== 'apply' && decision !== 'reject') {
        return out(state.proposals, () => state.proposals.length
          ? state.proposals.forEach(item => console.log(`${item.id.slice(0, 8)}  ${item.change.lab ? `[实验室 ${String(item.change.lab)}] 建议名 ${String(item.change.name)}，` : `[${item.slot}] `}${item.summary}`))
          : console.log('没有待确认的改动建议'))
      }
      const ids = flags.has('all') ? state.proposals.map(item => item.id) : args.slice(1).map(prefix => {
        const found = state.proposals.filter(item => item.id.startsWith(prefix))
        if (found.length !== 1) throw new Error(`找不到唯一的建议：${prefix}`)
        return found[0]!.id
      })
      const name = flag('name')
      if (name && ids.length !== 1) throw new Error('--name 只能配一条建议')
      await client.resolveProposals(ids, decision, name ? { [ids[0]!]: name } : undefined)
      out({ ok: true }, () => console.log(`已${decision === 'apply' ? '应用' : '拒绝'} ${ids.length} 条建议`))
    },
  },
  {
    name: 'firmware', usage: ['firmware\t列出 boardd 自带的固件（仓库的 firmware/）'],
    async run({ client, out }) {
      const { firmware } = await client.state()
      out(firmware, () => console.log(firmware.map(item => `${item.soc}\t${item.purpose}\t${item.path}\t${item.sha256.slice(0, 16)}…${item.note ? `\t${item.note}` : ''}`).join('\n') || '没有自带固件'))
    },
  },
  {
    name: 'remove', usage: ['remove <board> | export\t后端里登记的板子，remove 会让后端忘掉它'],
    async run({ client, out, target }) { await client.removeBoard(target().board); out({ ok: true }, () => console.log(`已移除 ${target().board}`)) },
  },
  { name: 'export', usage: [], async run({ client }) { process.stdout.write(await client.exportToml()) } },
]

/**
 * `boot` and `flash`: with --sdk the backend boots or flashes the board with an SDK's build, fetching it itself; `flash`
 * with a link or a file flashes that package.
 */
async function boot({ client, args, flag, json, out, remote, target, token }: Parameters<Command['run']>[0], command: 'boot' | 'flash') {
  const { board, die } = target()
  if (command === 'flash' && !flag('sdk')) {
    const from = args[1]
    if (!from || args.length > 2) throw new Error('用法：boardlab flash <board> <链接|文件> [--flasher <工具>]，或 boardlab flash <board> --sdk <SDK>')
    // A link is downloaded by the board's backend; a file here is sent to boardd first (once per content).
    const link = /^[a-z][a-z0-9+.-]*:\/\//i.test(from)
    const sha256 = link ? undefined : await client.sendFile(resolve(from), size => { if (!json) console.error(`已传 ${from}（${size} 字节）`) })
    if (!json) console.error(`${board}：刷机包 ${from}，要几分钟…`)
    const result = await client.flashPackage(board, { ...(link ? { url: from } : { sha256 }), flasher: flag('flasher') }, token())
    return out(result, () => console.log(result.output))
  }
  if (flag('sdk') || command === 'flash') {
    const method = command === 'flash' || flag('method') === 'download' ? 'download' : 'load'
    if (!json) console.error(`${board}：${method === 'download' ? '刷机' : '内存启动'} ${flag('sdk')}，板子所在主机自己从构建服务器取产物…`)
    const result = await client.bootSdk(board, { sdk: flag('sdk')!, method, variant: flag('variant'), ...(flag('break') ? { brk: flag('break')! } : {}) }, token())
    return out(result, () => console.log(result.output))
  }
  const files = args.slice(1)
  if (!files.length) throw new Error('缺少启动文件，例如 boardlab boot board1 fsbl u-boot-opensbi Image.itb')
  // Bare names like fsbl are boardd's own firmware; anything with a dot or slash is a file here. A remote boardd cannot
  // read this machine's files, so they are sent to it first (once per content).
  const paths = await Promise.all(files.map(async file => {
    if (/^[a-z0-9][a-z0-9-]*$/.test(file)) return file
    if (!remote) return resolve(file)
    return client.sendFile(resolve(file), size => { if (!json) console.error(`已传 ${file}（${size} 字节）`) })
  }))
  const result = await client.boot(board, paths, die, token())
  out(result, () => console.log(result.output))
}

export const boardCommands: CommandGroup = { id: 'boards', title: '板子', summary: '锁、复位、串口、启动、日志', commands }
