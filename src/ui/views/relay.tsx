/** A board's relays and buttons, worked one by one through its backend's relay controller, under the lock. */
import { useCallback, useEffect, useState } from 'react'
import type { Board, BoardChannels, Channel } from '../../shared/types.ts'
import { api } from '../api.ts'
import { Dialog, type Run } from '../kit.tsx'

const ACTION: Record<string, string> = { on: '接通', off: '断开', toggle: '切换', pulse: '接通一会儿', press: '按住', release: '松开', click: '按一下' }
const timed = (action: string) => action === 'pulse' || action === 'click'

export function RelayDialog({ board, onClose, onRun }: { board: Board, onClose: () => void, onRun: Run }) {
  const [data, setData] = useState<BoardChannels | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ms, setMs] = useState('1000')
  const load = useCallback(() => api.channels(board.name).then(next => { setData(next); setError(null) }, failure => setError((failure as Error).message)), [board.name])
  useEffect(() => { void load() }, [load])
  const act = (channel: Channel, action: string) => onRun(`${channel.label}：${ACTION[action] ?? action}`, () => api.setChannel(board.name, channel.id, action, timed(action) ? Number(ms) : null)).then(load)
  return (
    <Dialog title={`${board.name} 的继电器和按钮`} onClose={onClose} actions={<button onClick={onClose}>关闭</button>}>
      <p className="muted">直接控制这块板接在继电器控制器上的线，例如断电重启、按住 BOOT。要拿着锁。</p>
      {error && <p className="warn">{error}</p>}
      {!data && !error && <p className="muted">正在读取…</p>}
      {data && !data.channels.length && <p className="muted">没有登记继电器或按钮。在实验室里给这块板的线起别名（{board.lab?.device ?? board.name}/power 之类）就会列在这里。</p>}
      {data && data.channels.length > 0 && (
        <ul className="channels">
          {data.channels.map(channel => (
            <li key={channel.id}>
              <div className="grow"><b>{channel.label}</b><small className="muted">{channel.kind} · {channel.state ?? '—'}</small></div>
              <span className="actions">{channel.actions.map(action => <button key={action} onClick={() => void act(channel, action)}>{ACTION[action] ?? action}</button>)}</span>
            </li>
          ))}
        </ul>
      )}
      <label className="inline">「接通一会儿」「按一下」的时长<input type="number" min={1} max={600000} value={ms} onChange={event => setMs(event.target.value)} /> 毫秒</label>
    </Dialog>
  )
}
