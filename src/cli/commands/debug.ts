/**
 * `boardlab debug`: a board's debug path as its backend reports it, the session under the board's lock, the actions it
 * offers, and its trace channel as a stream. The command knows no adapter or protocol: what a path can do comes from
 * the backend (`GET`/`POST /api/debug`), and every name here is one the backend reported.
 */
import type { BoardsClient } from '../../shared/client.ts'
import type { DebugResult } from '../../shared/types.ts'
import type { Command, CommandGroup } from '../command.ts'

/** The actions every path offers; a path may offer more and says so (`halt`, `run`, `regs`, `trace`, …). */
const VERBS = ['path', 'status', 'start', 'stop', 'stream', 'halt', 'run', 'reset', 'step', 'regs'] as const

/** A debug session's bytes (base64 `data:` frames) written through, until interrupted or the session ends. */
function streamDebug(client: BoardsClient, board: string): Promise<void> {
  const req = client.open('GET', `/api/debug/stream?board=${encodeURIComponent(board)}`)
  return new Promise((resolve, reject) => {
    // Ctrl-C (or a closed pipe) ends the stream: without this the request would keep the process alive for ever.
    const stop = () => { req.destroy(); resolve() }
    process.once('SIGINT', stop)
    req.on('response', response => {
      if (response.statusCode !== 200) {
        let text = ''
        response.on('data', chunk => { text += chunk })
        response.on('end', () => {
          let message = text
          try { message = (JSON.parse(text) as { error?: string }).error ?? text } catch {}
          // A stream that could not be opened is a failed command, whatever the text it printed.
          process.exitCode = 1
          reject(new Error(message))
        })
        return
      }
      let buffer = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        buffer += chunk
        let at: number
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at); buffer = buffer.slice(at + 2)
          const data = block.match(/^data: (.*)$/m)?.[1]
          if (data) process.stdout.write(Buffer.from(data, 'base64'))
        }
      })
      response.on('end', () => resolve())
      response.on('error', reject)
    })
    req.on('error', error => { if (!req.destroyed) reject(error) })
    req.end()
  })
}

const commands: Command[] = [
  {
    name: 'debug', noBoard: false,
    usage: [
      'debug <board>\t这块板子的调试口：提供者、能做什么、会话状态（只读）',
      'debug start <board>\t启动调试会话（跟着板子的锁：先拿锁，板子一释放就停）',
      'debug stop <board>\t停止调试会话',
      'debug <board> halt|run|reset|step|regs\t对调试口执行一个动作（路径上报的其它动作也可以）',
      'debug stream <board>\t把调试会话的输出（链路）打到标准输出，Ctrl-C 停',
    ],
    async run({ client, args, json, out, token }) {
      // The verb comes first (`debug start <board>`) or after the board (`debug <board> halt`): one parse for both.
      const verbFirst = (VERBS as readonly string[]).includes(args[0] ?? '')
      const action = verbFirst ? args[0]! : (args[1] ?? 'status')
      const board = verbFirst ? args[1] : args[0]
      if (!board) throw new Error('用法：boardlab debug <board> [start|stop|stream|halt|run|reset|step|regs]')
      if (action === 'stream') return streamDebug(client, board)
      if (action === 'path' || action === 'status') {
        const got = await client.debugPath(board)
        return out(got.debug, () => {
          const path = got.debug
          if (!path) return console.log(`${board} 没有调试口`)
          console.log(`${board}：${path.title ?? path.provider}（${path.kinds.join(', ') || '什么都不提供'}）`)
          if (path.about) console.log(`  ${path.about}`)
          console.log(`  会话：${path.running ? `在跑${path.endpoint ? `（${path.endpoint}）` : ''}` : '未启动'}`)
          for (const item of path.state ?? []) console.log(`  ${item.label}: ${item.value}`)
        })
      }
      if (action === 'start') {
        const got = await client.debugStart(board, token(board))
        return out(got.debug, () => console.log(`调试会话起来了：${got.debug.title ?? got.debug.provider}${got.debug.endpoint ? `（${got.debug.endpoint}）` : ''}（跟着板子的锁，锁一释放就停）`))
      }
      if (action === 'stop') {
        const got = await client.debugStop(board, token(board))
        return out(got.debug, () => console.log(got.debug.message))
      }
      const got = await client.debugAction(board, action, token(board))
      out(got.debug, () => {
        const result = got.debug as DebugResult
        console.log(result.message)
        for (const item of result.data ?? []) console.log(`  ${item.label}: ${item.value}`)
      })
    },
  },
]

export const debugCommands: CommandGroup = {
  id: 'debug', title: '调试', summary: '调试口、会话、动作（halt/run/regs）和它的输出',
  commands,
}
