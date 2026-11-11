/** Commands on backends that list their own boards (labs): finding new boards, their free ports, and binding them. */
import { confirm, type Command, type CommandGroup } from '../command.ts'

const commands: Command[] = [
  {
    name: 'lab', noBoard: true, usage: [
      'lab kinds\t可以添加的实验室种类',
      'lab add <实验室> --kind <种类>\t添加一个实验室（之后在网页的设置里完成它的设置，比如装好主机）',
      'lab remove <实验室> [--yes]\t删除一个添加的实验室和它的板子（不能有人拿着锁）',
      'lab discover <实验室> [--slot <主机>/s<N>,…] [--yes] [--human [--host <主机>]]\t让实验室在空槽位上找板子（会复位没登记的线），找到一块登记一块；--slot 只找这些槽位；--human：没接复位线的板子，由人按提示逐块进下载模式',
      'lab rebuild <实验室> --host <主机> [--keep-used] [--yes]\t重新布线以后用：忘掉这台主机上发现过的板子和槽位，按现在的接线重新发现（以前用过的复位线先试，沿用原来的名字）；--keep-used 保留在用的板子，只去掉串口不见的、找空闲串口上的（别人拿着板子时也能用）',
    ],
    async run({ client, args, flag, flags, out }) {
      if (args[0] === 'kinds') { const kinds = await client.labKinds(); return out(kinds, () => { for (const kind of kinds) console.log(`${kind.kind}\t${kind.title}：${kind.about}`) }) }
      if (args[0] === 'add' && args[1]) {
        const kind = flag('kind')
        if (!kind) throw new Error('添加实验室要指定种类：--kind <种类>（boardlab lab kinds 列出）')
        const added = await client.addLab(args[1], kind)
        return out(added, () => console.log(`添加了实验室 ${added.id}（${added.kind}）：到网页的设置里完成它的设置`))
      }
      if (args[0] === 'remove' && args[1]) {
        if (!flags.has('yes') && !(await confirm(`删除实验室 ${args[1]}？它的板子从 boardlab 里去掉。`))) throw new Error('删除实验室需要确认（交互确认或 --yes）')
        const result = await client.removeLab(args[1])
        return out(result, () => console.log(`删除了实验室 ${args[1]}`))
      }
      if (args[0] === 'rebuild' && args[1]) {
        const host = flag('host')
        if (!host) throw new Error('重建要指定主机：--host <主机>')
        const keep = flags.has('keep-used')
        const ask = keep ? `重新发现 ${host}：保留在用的板子，忘掉串口不见的，在空闲串口上找板子（会复位没人用的线）。继续？` : `重建会忘掉 ${host} 上发现过的板子和槽位并复位它们，按现在的接线重新发现。继续？`
        if (!flags.has('yes') && !(await confirm(ask))) throw new Error(`${keep ? '重新发现' : '重建'}需要确认（交互确认或 --yes）`)
        const result = await client.rebuildLab(args[1], host, keep)
        return out(result, () => console.log(result.message))
      }
      if (args[0] !== 'discover' || !args[1]) throw new Error('lab 子命令：kinds | add <实验室> --kind <种类> | remove <实验室> | discover <实验室> | rebuild <实验室> --host <主机>')
      const slots = flag('slot')?.split(',').map(item => item.trim()).filter(Boolean)
      if (!flags.has('yes') && !(await confirm(`发现板子可能复位实验室 ${args[1]} 里的板子。继续？`))) throw new Error('发现板子需要确认（交互确认或 --yes）')
      const result = await client.discoverLab(args[1], { human: flags.has('human'), host: flag('host'), slots })
      out(result, () => console.log(`${result.message}${result.proposals ? '\n用 boardlab proposals 查看，boardlab proposals apply <id> [--name <板名>] 登记' : ''}`))
    },
  },
  {
    name: 'slots', noBoard: true, usage: ['slots <实验室>\t实验室里还没有板子用的串口和下载口（新接上的线），按主机列出'],
    async run({ client, args, out }) {
      if (!args[0]) throw new Error('缺少实验室名，例如 boardlab slots lab1')
      const ports = await client.labSlots(args[0])
      out(ports, () => {
        if (ports.error) console.log(`问不到实验室：${ports.error}`)
        for (const host of ports.hosts) {
          console.log(`${host.host}：${host.consoles.length || host.usb.length ? '' : '没有空闲端口'}`)
          for (const con of host.consoles) console.log(`  串口 ${con.id}  ${con.label}`)
          for (const usb of host.usb) console.log(`  下载口 ${usb.id}  ${usb.label}`)
        }
        if (!ports.hosts.length) console.log('实验室没有报告主机')
      })
    },
  },
  {
    name: 'bind', noBoard: true, usage: ['bind <实验室> --host <主机> --console <串口> --usb <下载口> [--name <板名>]\t用空闲的串口和下载口登记一块由人复位的板子，临时调试用；默认名 tmp-<主机>-<串口>'],
    async run({ client, args, flag, out }) {
      if (!args[0]) throw new Error('用法：boardlab bind <实验室> --host <主机> --console <串口> --usb <下载口> [--name <板名>]')
      const result = await client.bindLab(args[0], { host: flag('host') ?? '', console: flag('console') ?? '', usb: flag('usb') ?? '', name: flag('name') })
      out(result, () => console.log(`已登记 ${result.board}（由人复位：复位时按提示操作，再 boardlab confirm ${result.board}）`))
    },
  },
]

export const labCommands: CommandGroup = { id: 'labs', title: '实验室', summary: '添加实验室、发现和重建、空闲端口', commands }
