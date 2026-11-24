/** Commands on boards, whatever backend they are on: the list, locks, the relay, consoles, loading and the inventory. */
import { resolve } from 'node:path'
import type { PackageRequest } from '../../shared/client.ts'
import type { Board, FlashPlan, State } from '../../shared/types.ts'
import { following, parseDuration, type CliPresentation, type Command, type CommandGroup } from '../command.ts'
import { pickConsole, streamConsole } from '../console.ts'

const presentation: { current: CliPresentation } = { current: {} }
export function presentBoards(hooks: CliPresentation) { presentation.current = hooks }

function gateHint(gateToken: string | null) {
  const hint = gateToken ? presentation.current.lockTokenHint?.(gateToken) : null
  if (hint) console.log(hint)
}

function leaseText(board: Board) {
  const queue = board.waiters.length ? `；排队：${board.waiters.map((waiter, index) => `${index + 1}. ${waiter.holder}`).join(' ')}` : ''
  const busy = board.busy ? `；${board.busy.label}（${board.busy.by}）${board.busy.line ? `：${board.busy.line}` : ''}` : ''
  return (board.lease ? `${board.lease.holder} 使用中（${board.lease.purpose}）` : '空闲') + busy + queue
}

export function printBoards(boards: Board[]) {
  for (const board of boards) {
    const place = presentation.current.boardPlace?.(board) ?? (board.slot === null ? '  -' : `[${board.slot}]`)
    const details = presentation.current.boardDetails?.(board) ?? ''
    console.log(`${place} ${board.name}  ${board.product ?? '型号未知'}${details}  ${leaseText(board)}`)
    for (const chip of board.chips) {
      const detail = presentation.current.chipDetails?.(board, chip) ?? `串口 ${chip.serialPath ?? '-'}  下载口 ${chip.downloadUsbPath ?? '-'}${chip.usbId ? ` (${chip.usbId})` : ''}`
      console.log(`      ${chip.die}: ${detail}`)
    }
  }
}

function printState(state: State) {
  printBoards(state.boards)
  for (const line of presentation.current.emptyPlaces?.(state) ?? []) console.log(line)
  const details = presentation.current.stateDetails?.(state)
  if (details) console.log(details)
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
    name: 'confirm', usage: ['confirm <board> [<备注>] [--request <请求 id>]\t由人复位的板子：照提示按了 RESET 之后告诉实验室（不需要锁）；带上提示里的请求 id，重复确认不会报错'],
    async run({ client, args, flag, out, target }) { const result = await client.confirm(target().board, args.slice(1).join(' '), flag('request')); out(result, () => console.log(result.message)) },
  },
  {
    name: 'rename', usage: ['rename <board|槽位> <新名字>\t给板子改名：实验室里的名字、串口名、锁、队列和历史一起改（拿着锁或空闲时；实验室板子会自动带上实验室前缀）'],
    async run({ client, args, out, target, token, keepToken }) {
      const { board } = target()
      const name = args.slice(1).join(' ').trim()
      if (!name) throw new Error('要给新名字：boardlab rename <board> <新名字>')
      const old = token(board)
      const result = await client.renameBoard(board, name, old)
      if (old) { keepToken(board, null); keepToken(result.board, old) }
      out(result, () => console.log(`${board} 改名为 ${result.board}${result.message && result.message !== `${board} → ${result.board}` ? `：${result.message}` : ''}`))
    },
  },
  {
    name: 'model', usage: ['model <board> <型号>\t记下板子的型号（--clear 清掉）；填过的型号会记下来，下次出现在下拉列表里'],
    async run({ client, args, flags, out, target }) {
      const { board } = target()
      const clear = flags.has('clear')
      const product = args.slice(1).join(' ').trim()
      if (!clear && !product) throw new Error('要给型号：boardlab model <board> <型号>')
      await client.setModel(board, clear ? null : product)
      out({ board, product: clear ? null : product }, () => console.log(clear ? `${board} 的型号清掉了` : `${board} 的型号：${product}`))
    },
  },
  {
    name: 'models', noBoard: true, usage: ['models\t列出人们填过的型号，最近用的在前'],
    async run({ client, out }) {
      const result = await client.models()
      out(result, () => console.log(result.models.length ? result.models.join('\n') : '还没有人填过型号'))
    },
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
    name: 'logs',
    usage: [
      'logs <board>[.<die>] [--grep 文字] [--regex] [--since 时间] [--until 时间] [--limit 2000] [--first] [--numbers]\t搜串口日志：每行前面是它的行号（--numbers）',
      'logs <board>[.<die>] --grep 文字 --hits\t只看匹配在第几行，和一共多少行',
      'logs <board>[.<die>] --line N [--before 20] [--after 20]\t看第 N 行前后；--at 位置（start、end 或上次给的）也行',
    ],
    async run({ client, flag, flags, out, target }) {
      const { board, die } = target()
      const line = flag('line'), at = flag('at') ?? (line !== undefined ? `line:${line}` : undefined)
      if (line !== undefined && !/^\d+$/.test(line)) throw new Error(`--line 要写行号：${line}`)
      const result = await client.logs(board, {
        die, grep: flag('grep'), regex: flags.has('regex'), since: flag('since'), until: flag('until'), first: flags.has('first'),
        limit: flag('limit') ? Number(flag('limit')) : undefined, hits: flags.has('hits'), maxHits: flag('max-hits') ? Number(flag('max-hits')) : undefined,
        at, before: at ? Number(flag('before') ?? 20) : undefined, after: at ? Number(flag('after') ?? 20) : undefined,
      })
      out(result, () => {
        const total = result.total ?? null
        if (result.hits) {
          console.log(result.hits.join('\n'))
          console.error(`${result.matched} 行匹配${result.hitsTruncated ? `（只列了前 ${result.hits.length} 个）` : ''}${total !== null ? `，日志一共 ${total} 行` : ''}`)
          return
        }
        const numbered = !!at || flags.has('numbers')
        const width = String((result.numbers?.at(-1) ?? 0)).length
        if (at && result.moreBefore) console.log('…')
        result.lines.forEach((text, index) => console.log(numbered && result.numbers ? `${String(result.numbers[index]).padStart(width)}  ${text}` : text))
        if (at && result.moreAfter) console.log('…')
        if (at && result.snapped) console.error('要的那一行已经不在了，给的是离它最近的')
        if (!at && result.truncated) console.error(`${result.matched} 行匹配，只给了 ${result.lines.length} 行（--limit、--first）`)
      })
    },
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
      'boot <board>[.<die>] <固件名|http(s)链接|host:/板卡主机路径|本机文件>...\t按顺序内存启动，不写板子；URL 和 host: 路径由板卡主机取，本机文件上传是兜底；只改内核：boot <board> fsbl u-boot-opensbi <Image.itb>',
      '（boot、flash：Ctrl-C 只是不再跟着看，操作在 boardd 里继续，用 boardlab cancel <board> 停下它；--cancel-on-interrupt 让 Ctrl-C 直接取消；boardd 中途重启时操作不丢，命令行会重新连上并跟到它结束，按它的结果退出）',
    ],
    run: context => boot(context, 'boot'),
  },
  {
    name: 'flash',
    usage: [
      'flash <board> <链接|文件> [--flasher <工具>] [--refresh]\t用刷机包刷机（要拿锁）：链接由板子所在主机下载（后端可以按链接缓存一段时间，--refresh 重新下载；收哪些链接看 show 里的 packages），本机的文件先传给 boardd；不给 --flasher 时板卡主机按板子、SoC、主机的顺序选第一个能用的刷机工具，下载和复位前就先检查；--flasher 指定一个，主机上没有或用不了就报错并列出可用的',
      'flash <board> --image <市场>:<路径>\t用镜像市场里的镜像刷机（boardlab images 看有哪些）',
      'flash <board> <包> --plan\t只看这个包会写什么：各介质和分区，哪些能单独刷；不碰板子',
      'flash <board> <包> [--partitions a,b] [--reset]\t只刷这几个分区（名字照 --plan 列的）；--reset 刷完复位，从刚写的系统启动',
      'flash <board> --sdk <SDK> [--variant V]\t用 SDK 的产物刷机，同 boot --sdk <SDK> --method download',
    ],
    run: context => boot(context, 'flash'),
  },
  {
    name: 'cancel', noBoard: true,
    usage: ['cancel <board|lab:实验室>\t让 boardd 在板子或实验室上正在做的事停下（启动、刷机、复位、发现…；板子有锁时要拿着锁）：它在正在做的那一步结束后停下'],
    async run({ client, args, out, token }) {
      const target = args[0]
      if (!target) throw new Error('缺少要取消的板子或实验室：boardlab cancel <board|lab:实验室>')
      const result = await client.cancel(target, target.startsWith('lab:') ? null : token(target))
      out(result, () => console.log(result.message))
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
async function boot(context: Parameters<Command['run']>[0], command: 'boot' | 'flash') {
  const { client, flags, target, token } = context
  const { board } = target()
  return following(client, board, () => booting(context, command), { cancelOnInterrupt: flags.has('cancel-on-interrupt'), token: token() })
}

async function booting({ client, args, flag, flags, json, out, remote, target, token }: Parameters<Command['run']>[0], command: 'boot' | 'flash') {
  const { board, die } = target()
  if (command === 'flash' && !flag('sdk')) {
    const image = flag('image')
    const from = args[1]
    if ((!from && !image) || (from && image) || args.length > 2) throw new Error('用法：boardlab flash <board> <链接|文件> | --image <市场>:<路径> [--plan] [--partitions a,b] [--reset] [--flasher <工具>]，或 boardlab flash <board> --sdk <SDK>')
    let pkg: PackageRequest
    if (image) {
      const at = image.indexOf(':')
      if (at < 1 || at === image.length - 1) throw new Error(`--image 要写成 <市场>:<路径>，例如 main:v1.0/image.zip：${image}`)
      pkg = { image: { market: image.slice(0, at), path: image.slice(at + 1) } }
    } else {
      // A link is fetched by the board's backend; a file here is sent to boardd first (once per content).
      const link = /^[a-z][a-z0-9+.-]*:\/\//i.test(from!)
      pkg = link ? { url: from!, ...(flags.has('refresh') ? { refresh: true } : {}) } : { sha256: await client.sendFile(resolve(from!), size => { if (!json) console.error(`已传 ${from}（${size} 字节）`) }) }
    }
    if (flag('flasher')) pkg.flasher = flag('flasher')!
    const what = image ?? from!
    if (flags.has('plan')) {
      const plan = await client.flashPlan(board, pkg, text => { if (!json) process.stderr.write(text) }, token())
      return out(plan, () => printPlan(plan))
    }
    const partitions = flag('partitions')?.split(',').map(name => name.trim()).filter(Boolean)
    if (!json) console.error(`${board}：刷机包 ${what}${partitions?.length ? `，只刷 ${partitions.join('、')}` : ''}，要几分钟…`)
    const result = await client.flashPackage(board, { ...pkg, ...(partitions?.length ? { partitions } : {}), ...(flags.has('reset') ? { reset: true } : {}) }, token())
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
  // Bare names are boardd firmware, sha256: a file already on boardd. http(s) and host:/... are resolved by the board
  // host, never uploaded. An ordinary path here is the fallback: read by a local boardd, otherwise uploaded.
  const paths = await Promise.all(files.map(async file => {
    if (/^[a-z0-9][a-z0-9-]*$/.test(file) || /^sha256:[0-9a-f]{64}$/.test(file) || /^https?:\/\//i.test(file) || file.startsWith('host:/')) return file
    if (!remote) return resolve(file)
    return client.sendFile(resolve(file), size => { if (!json) console.error(`已传 ${file}（${size} 字节）`) })
  }))
  const result = await client.boot(board, paths, die, token())
  out(result, () => console.log(result.output))
}

/** A package's plan as a person reads it: each medium, then its partitions with where they go and what writes them. */
function printPlan(plan: FlashPlan) {
  const size = (bytes: number | null) => bytes === null ? '—' : bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GiB` : bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(bytes % (1 << 20) ? 1 : 0)} MiB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KiB` : `${bytes} B`
  console.log(`${plan.package}${plan.partial ? '（可以只刷其中几个分区：--partitions）' : '（只能整包刷）'}`)
  for (const medium of plan.media) {
    console.log(`\n${medium.label}${medium.size !== null ? `  ${size(medium.size)}` : ''}`)
    for (const part of medium.partitions) {
      const range = part.offset === null ? '' : `@${size(part.offset)}`
      console.log(`  ${part.selectable ? '·' : ' '} ${part.name.padEnd(12)} ${range.padEnd(12)} ${size(part.size).padEnd(10)} ${part.image ? `${part.image}（${size(part.payload)}）` : '（包里没有，不写）'}`)
    }
  }
  for (const note of plan.notes) console.log(`\n注意：${note}`)
}

export const boardCommands: CommandGroup = { id: 'boards', title: '板子', summary: '锁、复位、串口、启动、日志', commands }
