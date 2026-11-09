/** The online console: one live terminal session per chip, kept while the page shows it, and its panel. */
import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { Board } from '../../shared/types.ts'
import { api, type PageState } from '../api.ts'
import { who } from '../kit.tsx'

// eslint-disable-next-line no-control-regex
const ANSI_CODES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g
/** serial-mux's log prefixes each backlog line with the time it was read: `[2026-11-05 14:39:12] `. */
const LOG_STAMP = /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] ?/

/**
 * Open terminals, kept across board and page switches so coming back to a console shows it as it was, live, without
 * reconnecting. Each has one stream from boardd. The × closes one; beyond a few, or after a while out of sight, the
 * least recently shown is closed; all close when the page goes away.
 */
interface LiveConsole {
  key: string
  status: ConsoleStatus
  mine: boolean
  lastShown: number
  attached: boolean
  attach(host: HTMLElement, onStatus: (status: ConsoleStatus) => void, onError: (text: string) => void): void
  detach(): void
  dispose(): void
}
type ConsoleStatus = 'connecting' | 'live' | 'closed' | 'retry'
const consoles = new Map<string, LiveConsole>()
const MAX_CONSOLES = 3
const HIDDEN_CONSOLE_MS = 10 * 60_000

function liveConsole(board: string, die: string | undefined): LiveConsole {
  const key = `${board}\0${die ?? ''}`
  const known = consoles.get(key)
  if (known) return known
  const el = document.createElement('div')
  el.className = 'xterm-box'
  const term = new Terminal({ convertEol: false, cursorBlink: true, fontSize: 13, scrollback: 20_000, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', theme: { background: '#11151c' } })
  const fit = new FitAddon()
  term.loadAddon(fit)
  let opened = false, onStatus: (status: ConsoleStatus) => void = () => {}, onError: (text: string) => void = () => {}
  const observer = new ResizeObserver(() => { try { fit.fit() } catch {} })
  const setStatus = (status: ConsoleStatus) => { live.status = status; onStatus(status) }
  const source = new EventSource(`api/console?raw=1&board=${encodeURIComponent(board)}${die ? `&die=${encodeURIComponent(die)}` : ''}`)
  // The stream reconnects on its own when the port drops (a reset can do that). The backlog it sends again is mostly
  // on screen already: only the lines after the last one shown are written, so the terminal never starts over.
  let shown = false, tail = ''
  const lastLine = () => tail.replace(ANSI_CODES, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) ?? null
  source.addEventListener('history', event => {
    const lines = JSON.parse((event as MessageEvent).data) as string[]
    if (!shown) {
      term.write(lines.join('\r\n') + '\r\n')
      shown = true
    } else {
      const last = lastLine()
      const at = last === null ? -1 : lines.findLastIndex(line => line.replace(ANSI_CODES, '').replace(LOG_STAMP, '').trim() === last)
      const missed = at >= 0 ? lines.slice(at + 1) : []
      term.write(`\r\n\x1b[2m[串口重新连接${missed.length ? `，补上断开期间的 ${missed.length} 行` : ''}]\x1b[0m\r\n` + (missed.length ? missed.join('\r\n') + '\r\n' : ''))
    }
    tail = lines.slice(-5).map(line => line.replace(LOG_STAMP, '')).join('\n')
    setStatus('live')
  })
  source.addEventListener('output', event => {
    const text = JSON.parse((event as MessageEvent).data) as string
    term.write(text)
    tail = (tail + text).slice(-4096)
  })
  source.addEventListener('closed', () => setStatus('closed'))
  source.onerror = () => setStatus(source.readyState === EventSource.CLOSED ? 'closed' : 'retry')
  // Keystrokes go out in order, a few milliseconds' worth at a time, while you hold the lock.
  let pending = '', timer: number | undefined, chain = Promise.resolve()
  const flush = () => {
    const data = pending
    pending = ''
    if (data) chain = chain.then(() => api.input(board, die, data)).then(() => {}, error => onError((error as Error).message))
  }
  term.onData(data => {
    pending += data
    window.clearTimeout(timer)
    timer = window.setTimeout(flush, 8)
  })
  const live: LiveConsole = {
    key, status: 'connecting', mine: false, lastShown: Date.now(), attached: false,
    attach(host, status, error) {
      onStatus = status
      onError = error
      host.appendChild(el)
      if (!opened) { term.open(el); opened = true }
      observer.observe(el)
      live.attached = true
      live.lastShown = Date.now()
      requestAnimationFrame(() => { try { fit.fit() } catch {} ; term.focus() })
      status(live.status)
    },
    detach() {
      observer.disconnect()
      el.remove()
      live.attached = false
      live.lastShown = Date.now()
      onStatus = () => {}
    },
    dispose() {
      flush()
      window.clearTimeout(timer)
      source.close()
      observer.disconnect()
      el.remove()
      term.dispose()
      consoles.delete(key)
    },
  }
  consoles.set(key, live)
  // Keep only a few streams open: browsers allow few connections to one site, and the page needs some for itself.
  const hidden = [...consoles.values()].filter(item => item !== live && !item.attached).sort((a, b) => a.lastShown - b.lastShown)
  while (consoles.size > MAX_CONSOLES && hidden.length) hidden.shift()!.dispose()
  return live
}

const closeConsoles = (match: (live: LiveConsole) => boolean) => { for (const live of [...consoles.values()]) if (match(live)) live.dispose() }
window.addEventListener('pagehide', () => closeConsoles(() => true))
window.setInterval(() => closeConsoles(live => !live.attached && Date.now() - live.lastShown > HIDDEN_CONSOLE_MS), 60_000)

/**
 * The online console: a terminal on the chip's serial port. Output streams from boardd; while you hold the lock, what you
 * type goes to the board as you type it, through boardd, the same way for boards here and in labs.
 */
export function Console({ board, state, onClose, onError }: { board: Board, state: PageState, onClose: () => void, onError: (text: string) => void }) {
  const dies = board.chips.filter(chip => chip.online || board.lab)
  const [die, setDie] = useState(dies[0]?.die)
  const [status, setStatus] = useState<ConsoleStatus>('connecting')
  const host = useRef<HTMLDivElement>(null)
  const mine = board.lease?.holder === state.you
  const current = useRef<LiveConsole | null>(null)
  // The page re-renders on every board change; only the board and chip pick the terminal, never a new callback.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  useEffect(() => {
    const live = liveConsole(board.name, die)
    current.current = live
    live.mine = mine
    live.attach(host.current!, setStatus, text => onErrorRef.current(text))
    return () => live.detach()
  }, [board.name, die])
  useEffect(() => { if (current.current) current.current.mine = mine }, [mine])
  const label = { connecting: '连接中…', live: '实时', closed: '串口已关闭', retry: '连接中断，重试中…' }[status]
  const close = () => { current.current?.dispose(); onClose() }
  return (
    <aside className="console" aria-label="串口控制台">
      <header>
        <div className="title">
          <h3>{board.name}</h3>
          <span className="muted" data-testid="console-status"><span className={`dot ${status === 'live' ? 'dot-ok' : 'dot-off'}`} />{label} · 直接输入{board.lease && !mine ? `（锁在 ${who(board.lease.holder)} 手里，你的输入会和它的混在一起）` : ''}</span>
        </div>
        {dies.length > 1 && (
          <select value={die} onChange={event => setDie(event.target.value)} aria-label="芯片">
            {dies.map(chip => <option key={chip.die} value={chip.die}>{chip.die}</option>)}
          </select>
        )}
        <button className="icon" onClick={() => onClose()} title="收起（串口保持连接，回来时原样显示）" aria-label="收起控制台">–</button>
        <button className="icon" onClick={close} title="关闭这个串口" aria-label="关闭控制台">×</button>
      </header>
      <div ref={host} className="terminal xterm-host" data-testid="console-output" />
    </aside>
  )
}
