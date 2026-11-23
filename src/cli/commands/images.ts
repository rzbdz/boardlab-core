/**
 * `boardlab images`: the image markets boardd has set up, and a folder of one, as the page's 镜像 view lists them. The
 * command knows no kind of market: what a market holds and how it files images under SoCs comes from boardd.
 */
import type { MarketEntry } from '../../shared/types.ts'
import type { Command, CommandGroup } from '../command.ts'

function size(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined) return ''
  return bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GiB` : bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MiB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KiB` : `${bytes} B`
}

function row(market: string, entry: MarketEntry) {
  const name = entry.kind === 'folder' ? `${entry.name}/` : entry.name
  const facts = [entry.soc, size(entry.size), entry.modified?.slice(0, 16).replace('T', ' '), entry.note].filter(Boolean).join('  ')
  return `  ${name.padEnd(48)} ${facts}${entry.kind === 'image' ? `\n    ${market}:${entry.path}` : ''}`
}

const commands: Command[] = [
  {
    name: 'images', noBoard: true,
    usage: [
      'images\t设好的镜像市场',
      'images <市场>[:<路径>] [--soc <SoC>] [--refresh]\t市场里的一层：文件夹在前，新的在前；--soc 只看这个 SoC 的；一分钟内列过的不再问市场，--refresh 重新读',
      'images <市场>:<镜像> --targets\t这个镜像能刷到哪些板子上：你拿着的、空闲的，其余说为什么不行',
    ],
    async run({ client, args, flags, flag, json, out }) {
      const place = args[0]
      if (!place) {
        const markets = await client.markets()
        return out(markets, () => {
          if (!markets.length) return console.log('还没有设好的镜像市场：市场由 boardd 的模块按它们的配置设置')
          for (const market of markets) {
            console.log(`${market.id.padEnd(16)} ${market.title}（${market.kindTitle}，${market.source} 设的）`)
            if (market.error) console.log(`  用不了：${market.error}`)
          }
        })
      }
      const at = place.indexOf(':')
      const market = at < 0 ? place : place.slice(0, at)
      const path = at < 0 ? '' : place.slice(at + 1)
      if (flags.has('targets')) {
        const targets = await client.marketTargets(market, path)
        return out(targets, () => {
          if (!targets.length) return console.log(`没有板子能刷 ${place}（后端不收这种包，或 SoC 对不上）`)
          for (const target of targets) console.log(`  ${target.board.padEnd(24)} ${(target.soc ?? '').padEnd(8)} ${target.mine ? '你拿着' : target.free ? '空闲' : ''}${target.why ? target.why : ''}`)
        })
      }
      const listing = await client.marketFolder(market, path, { soc: flag('soc') ?? null, refresh: flags.has('refresh') })
      out(listing, () => {
        console.log(`${market}:${listing.path || '/'}（${listing.readAt.slice(11, 19)} 读的）`)
        if (!listing.entries.length) console.log('  （空）')
        for (const entry of listing.entries) console.log(row(market, entry))
      })
    },
  },
]

export const imageCommands: CommandGroup = {
  id: 'images', title: '镜像市场', summary: '镜像市场里有哪些镜像，能刷到哪些板子上（flash --image 刷）',
  commands,
}
