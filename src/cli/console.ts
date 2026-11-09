/**
 * `boardlab console`: a chip's serial console as a terminal, with picocom's keys, and choosing one interactively.
 */
import type { BoardsClient } from '../shared/client.ts'

/**
 * `boardlab console -i`: choose a console with the arrow keys (or j/k, or its number), Enter to open, q to cancel;
 * then say whether a person is typing (a person types without the lock).
 */
export async function pickConsole(client: BoardsClient, holder: string): Promise<{ target: { board: string, die: string | undefined }, human: boolean } | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('console -i 要在终端里用；不在终端时写 boardlab console <板子>')
  const state = await client.state()
  const items = state.boards.flatMap(board => board.chips.map(chip => ({
    target: { board: board.name, die: board.chips.length > 1 ? chip.die : undefined } as { board: string, die: string | undefined },
    label: `${board.name}${board.chips.length > 1 ? `.${chip.die}` : ''}`,
    where: board.lab ? `${chip.serialPath ?? board.lab.device}` : (chip.serialPath ?? '-'),
    who: board.lease ? `${board.lease.holder} 在用（${board.lease.purpose}）` : board.lab?.heldBy ? `实验室里 ${board.lab.heldBy} 在用` : '空闲',
    online: chip.online || !!board.lab,
  })))
  if (!items.length) throw new Error('没有板子')
  const width = Math.max(...items.map(item => item.label.length))
  let at = 0
  const out = process.stdout
  const draw = (first = false) => {
    if (!first) out.write(`\x1b[${items.length + 2}A`)
    out.write('\x1b[2K选串口（↑↓ 或 j/k 移动，回车打开，q 取消）\r\n')
    items.forEach((item, index) => out.write(`\x1b[2K${index === at ? '\x1b[7m❯' : ' '} ${String(index + 1).padStart(2)}. ${item.label.padEnd(width)}  ${item.where}  ${item.who}${item.online ? '' : '  （串口不在线）'}\x1b[0m\r\n`))
    out.write('\x1b[2K\r\n')
  }
  const key = () => new Promise<string>(resolve => process.stdin.once('data', data => resolve(data.toString('utf8'))))
  process.stdin.setRawMode(true)
  process.stdin.resume()
  try {
    draw(true)
    let typed = ''
    for (;;) {
      const k = await key()
      if (k === 'q' || k === '\x03' || k === '\x1b') return null
      if (k === '\x1b[A' || k === 'k') { at = (at + items.length - 1) % items.length; typed = '' }
      else if (k === '\x1b[B' || k === 'j') { at = (at + 1) % items.length; typed = '' }
      else if (/^\d$/.test(k)) { typed += k; const n = Number(typed); if (n >= 1 && n <= items.length) at = n - 1; else typed = k }
      else if (k === '\r' || k === '\n') break
      draw()
    }
    const chosen = items[at]!
    const lease = (await client.board(chosen.target.board)).board.lease
    if (lease?.holder === holder) return { target: chosen.target, human: false }
    if (!holder.startsWith('user:')) return { target: chosen.target, human: false }
    out.write(`${chosen.label}：${lease ? `锁在 ${lease.holder} 手里，` : ''}你是人在键盘前操作吗？是的话不查锁、直接输入 [y/N] `)
    const answer = await key()
    out.write(`${answer.trim() || 'N'}\r\n`)
    return { target: chosen.target, human: /^y/i.test(answer) }
  } finally {
    process.stdin.setRawMode(false)
    process.stdin.pause()
  }
}

/** picocom's escape: Ctrl-A, then a command key. */
const ESCAPE = 0x01
const ESCAPE_HELP = '\r\n*** boardlab console: Ctrl-A Ctrl-X（或 Ctrl-Q）退出，Ctrl-A Ctrl-A 发送 Ctrl-A，Ctrl-A Ctrl-H 显示这段帮助 ***\r\n'

/**
 * Keys typed into an interactive console, read the way picocom reads them: Ctrl-A starts a command — Ctrl-X or Ctrl-Q
 * leaves, Ctrl-A sends a Ctrl-A, Ctrl-H shows help — and everything else, Ctrl-C included, goes to the board.
 */
export function consoleKeys(): (chunk: Buffer) => { send: Buffer, quit: boolean, help: boolean } {
  let armed = false
  return chunk => {
    const send: number[] = []
    let quit = false, help = false
    for (const byte of chunk) {
      if (quit) break
      if (armed) {
        armed = false
        if (byte === 0x18 || byte === 0x11) quit = true
        else if (byte === ESCAPE) send.push(ESCAPE)
        else if (byte === 0x08 || byte === 0x7f || byte === 0x3f) help = true
        continue
      }
      if (byte === ESCAPE) armed = true
      else send.push(byte)
    }
    return { send: Buffer.from(send), quit, help }
  }
}

/**
 * `boardlab console`: the chip's serial console as a terminal. Output streams as the board writes it; on a terminal,
 * what you type goes to the board as you type it while you hold the lock (Ctrl-C too), and Ctrl-A Ctrl-X leaves, as in
 * picocom. Without a terminal it only prints the output, until interrupted.
 */
export function streamConsole(client: BoardsClient, board: string, die: string | undefined, token: string | null, mine: boolean, human = false): Promise<void> {
  const canType = mine || human
  const tty = process.stdin.isTTY && process.stdout.isTTY
  const path = `/api/console?raw=1&board=${encodeURIComponent(board)}${die ? `&die=${encodeURIComponent(die)}` : ''}`
  return new Promise((resolve, reject) => {
    const req = client.open('GET', path)
    let done = false
    const finish = (error?: Error) => {
      if (done) return
      done = true
      if (tty) { process.stdin.setRawMode(false); process.stdin.pause() }
      req.destroy()
      if (error) reject(error); else resolve()
    }
    req.on('response', response => {
      if (response.statusCode !== 200) {
        let text = ''
        response.on('data', chunk => { text += chunk })
        response.on('end', () => { let message = text; try { message = JSON.parse(text).error ?? text } catch {} ; finish(new Error(message)) })
        return
      }
      const eol = tty ? '\r\n' : '\n'
      let buffer = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index); buffer = buffer.slice(index + 2)
          const event = block.match(/^event: (.*)$/m)?.[1]
          const data = block.match(/^data: (.*)$/m)?.[1]
          if (!data) continue
          const value = JSON.parse(data)
          if (event === 'history') {
            process.stdout.write((value as string[]).join(eol) + eol)
            if (tty) process.stdout.write(`\r\n*** ${board}${die ? `.${die}` : ''}：${mine ? '直接输入' : human ? '直接输入（人，不查锁）' : '只读（拿锁后才能输入，人可以加 --human）'}，Ctrl-A Ctrl-X 退出 ***\r\n`)
          } else if (event === 'output') process.stdout.write(value)
          else if (event === 'closed') process.stdout.write(`${eol}[串口关闭：${value}]${eol}`)
        }
      })
      response.on('end', () => finish())
    })
    req.on('error', error => finish(error))
    req.end()
    if (!tty) { process.once('SIGINT', () => finish()); return }
    // Raw mode: Ctrl-C is a key for the board, not a signal for us.
    process.stdin.setRawMode(true)
    process.stdin.resume()
    const keys = consoleKeys()
    let pending = Buffer.alloc(0), sending = false, warned = false
    const flush = async () => {
      if (sending || !pending.length) return
      sending = true
      const data = pending.toString('utf8')
      pending = Buffer.alloc(0)
      try { await client.input(board, { die, data, token, human: human && !mine }) }
      catch (error) {
        if (!warned) { process.stdout.write(`\r\n*** 输入没有送到：${(error as Error).message} ***\r\n`); warned = true }
      } finally { sending = false; void flush() }
    }
    process.stdin.on('data', (chunk: Buffer) => {
      const { send, quit, help } = keys(chunk)
      if (help) process.stdout.write(ESCAPE_HELP)
      if (send.length) {
        if (!canType) { if (!warned) { process.stdout.write('\r\n*** 只读：先 boardlab lock 这块板才能输入（人可以用 --human 直接输入）；Ctrl-A Ctrl-X 退出 ***\r\n'); warned = true } }
        else { pending = Buffer.concat([pending, send]); void flush() }
      }
      if (quit) { process.stdout.write('\r\n*** 已退出串口 ***\r\n'); finish() }
    })
  })
}
