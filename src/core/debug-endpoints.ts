/**
 * Debugging a board: its path as its backend reports it, the session under the board's lock, and the session's bytes.
 * One set of endpoints for every backend that offers `debug` (see `debug.ts`), so the page and the CLI work the same on
 * any of them, and the endpoints a backend gets are the ones the contract promises.
 */
import { RawReply, required, type Endpoint } from './api.ts'
import type { ConsoleSession } from './console.ts'
import type { DebugCapability } from './debug.ts'
import { BoardError } from './errors.ts'
import type { BoardLab } from './lab.ts'

export function debugEndpoints(lab: BoardLab): Endpoint[] {
  const token = (body: any) => typeof body?.token === 'string' ? body.token : null
  const routeOf = (name: string) => {
    const route = lab.backends.route(name)
    const debug = route.backend.debug
    if (!debug) throw new BoardError('invalid', `${name} 所在的后端不提供调试`)
    return { route, debug }
  }
  const streamOf = (body: any) => {
    const name = lab.boards.resolve(required(body.board, 'board'))
    const { route, debug } = routeOf(name)
    if (!debug.stream) throw new BoardError('invalid', `${name} 的调试口没有可以看的输出`)
    return { name, route, debug: debug as DebugCapability & { stream: NonNullable<DebugCapability['stream']> } }
  }
  return [
    {
      method: 'POST', path: '/api/debug',
      about: '一块板子的调试：action=path（它有什么）|start|stop，或它提供的动作（halt、run、reset、step、regs 等）；除 path 外要拿着板子的锁，会话跟着锁走，锁一释放就停',
      handle: async ({ body, caller }) => {
        const name = lab.boards.resolve(required(body.board, 'board'))
        const { route, debug } = routeOf(name)
        const action = String(body.action ?? 'path')
        // Reading the path changes nothing on the board; everything else runs under its lock, shown on the board.
        if (action === 'path') return { debug: await debug.path(route.config, route.target) }
        const held = lab.locks.authorize(name, { holder: caller.holder, token: token(body) })
        const run = () => {
          if (action === 'start') return debug.start(route.config, route.target)
          if (action === 'stop') return debug.stop(route.config, route.target).then(message => ({ message }))
          return debug.action(route.config, route.target, action)
        }
        const result = await lab.kernel.doing([name], 'debug', `调试：${action}`, caller.holder, async () => run(), { lease: held.id })
        lab.kernel.record(caller.holder, name, 'debug', action, true)
        return { debug: result }
      },
    },
    {
      method: 'GET', path: '/api/debug/stream', about: '调试会话的字节（链路输出）：会话的水流，按到达转发（base64 的 data 帧）；会话不在时是一句带原因的失败',
      handle: async ({ query, signal }) => {
        const name = lab.boards.resolve(required(query.get('board'), 'board'))
        const { route, debug } = routeOf(name)
        const open = debug.stream
        if (!open) throw new BoardError('invalid', `${name} 的调试口没有可以看的输出`)
        // Opened before the reply starts: a session that cannot be opened is a failure with its reason, rather than
        // error text arriving as bytes a viewer would print as if the board had said it (and a 200 that never ends).
        let session: ConsoleSession
        try {
          session = await open.call(debug, route.config, route.target)
        } catch (error) {
          throw new BoardError('invalid', `打不开 ${name} 的调试输出：${(error as Error).message}`)
        }
        const queue: Buffer[] = []
        let wake: (() => void) | null = null
        let ended = false
        const off = session.onOutput(data => { queue.push(Buffer.from(data)); wake?.(); wake = null })
        session.onClose(() => { ended = true; wake?.(); wake = null })
        const events = (async function* () {
          try {
            while (!signal.aborted && !ended) {
              while (queue.length) yield `data: ${queue.shift()!.toString('base64')}\n\n`
              if (ended) break
              await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 15_000) })
              if (!queue.length && !ended) yield ': ping\n\n'
            }
          } finally { off(); session.close() }
        })()
        return new RawReply(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }, events)
      },
    },
    {
      method: 'POST', path: '/api/debug/input', about: '往调试会话写字节（base64 的 data），要拿着板子的锁',
      handle: async ({ body, caller }) => {
        const { name, route, debug } = streamOf(body)
        lab.locks.authorize(name, { holder: caller.holder, token: token(body) })
        const session = await debug.stream(route.config, route.target)
        try { session.send(Buffer.from(String(body.data ?? ''), 'base64')) } finally { session.close() }
        return { ok: true }
      },
    },
  ]
}
