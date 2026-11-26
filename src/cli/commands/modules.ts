/**
 * `boardlab module`: what boardd loaded, as each module reports itself — what it is, what it needs and what it offers,
 * and whether it runs. A module that waits for a service nobody provides says so here, with what it waits for, instead
 * of failing silently. The command knows no module: every name it prints is the module's own.
 */
import type { Command, CommandGroup } from '../command.ts'

const STATUS: Record<string, string> = { active: '在跑', pending: '等着', failed: '起不来', stopped: '停了' }

const commands: Command[] = [
  {
    name: 'module', noBoard: true,
    usage: [
      'module [list] [--tag <标签>]\tboardd 装了哪些模块：它是什么、要什么、给什么、在不在跑；--tag 只看带这个标签的',
      'module search <文字>\t按名字、说明和标签找模块',
    ],
    async run({ client, args, flag, out }) {
      const state = await client.state()
      const plugins = state.plugins ?? []
      const words = args.slice(1)
      const tag = flag('tag')
      const found = plugins.filter(plugin => (!tag || plugin.tags.includes(tag)) && (!words.length || words.every(word => `${plugin.id} ${plugin.title} ${plugin.about} ${plugin.tags.join(' ')}`.toLowerCase().includes(word.toLowerCase()))))
      return out(found, () => {
        if (!plugins.length) return console.log('boardd 没有装任何模块')
        if (!found.length) return console.log(`没有符合的模块（装了 ${plugins.length} 个）`)
        for (const plugin of found) {
          const status = STATUS[plugin.status] ?? plugin.status
          console.log(`${plugin.id}  ${plugin.title}  ${status}${plugin.why ? `：${plugin.why}` : ''}`)
          if (plugin.about) console.log(`  ${plugin.about}`)
          const edges = [
            plugin.inject.length ? `要 ${plugin.inject.join('、')}` : '',
            plugin.provide.length ? `给 ${plugin.provide.join('、')}` : '',
            plugin.tags.length ? `标签 ${plugin.tags.join('、')}` : '',
          ].filter(Boolean).join('；')
          if (edges) console.log(`  ${edges}`)
        }
      })
    },
  },
]

export const moduleCommands: CommandGroup = {
  id: 'module', title: '模块', summary: '装了哪些模块，各自要什么、给什么、在不在跑',
  commands,
}
