/** Commands on backends that list their own boards (labs): finding new boards, their free ports, and binding them. */
import { confirm, type Command, type CommandGroup } from '../command.ts'

const commands: Command[] = [
  {
    name: 'lab', noBoard: true, usage: [
      'lab discover <实验室> [--slot <主机>/s<N>,…] [--yes] [--human [--host <主机>]]\t让实验室在空槽位上找板子（会复位没登记的线），找到一块登记一块；--slot 只找这些槽位；--human：没接复位线的板子，由人按提示逐块进下载模式',
      'lab rebuild <实验室> --host <主机> [--yes]\t重新布线以后用：忘掉这台主机上发现过的板子和槽位，按现在的接线重新发现（以前用过的复位线先试，沿用原来的名字）',
    ],
    async run({ client, args, flag, flags, out }) {
      if (args[0] === 'rebuild' && args[1]) {
        const host = flag('host')
        if (!host) throw new Error('重建要指定主机：--host <主机>')
        if (!flags.has('yes') && !(await confirm(`重建会忘掉 ${host} 上发现过的板子和槽位并复位它们，按现在的接线重新发现。继续？`))) throw new Error('重建需要确认（交互确认或 --yes）')
        const result = await client.rebuildLab(args[1], host)
        return out(result, () => console.log(result.message))
      }
      if (args[0] !== 'discover' || !args[1]) throw new Error('lab 子命令：discover <实验室> | rebuild <实验室> --host <主机>')
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

export const labCommands: CommandGroup = { title: '实验室', commands }
