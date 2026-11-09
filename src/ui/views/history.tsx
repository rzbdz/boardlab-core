/** The history tab: actions and locks, and what modules keep (scans). */
import { useEffect, useState } from 'react'
import { api, type History, type PageState } from '../api.ts'
import { loadedUis } from '../extensions.ts'
import { ACTIONS, LEASE, Section, shortenLinks, time, who } from '../kit.tsx'

export function HistoryTab({ refreshKey, state }: { refreshKey: number, state: PageState }) {
  const [history, setHistory] = useState<History | null>(null)
  const [board, setBoard] = useState('')
  const [limit, setLimit] = useState(40)
  useEffect(() => { void api.history().then(setHistory) }, [refreshKey])
  if (!history) return <p className="muted">加载中…</p>
  const boards = [...new Set(history.actions.map(action => action.board).filter((name): name is string => !!name))].sort()
  const actions = history.actions.filter(action => !board || action.board === board)
  return (
    <div className="stack narrow">
      <Section title="操作记录" extra={
        <select value={board} onChange={event => { setBoard(event.target.value); setLimit(40) }} aria-label="按板子筛选">
          <option value="">全部板子</option>
          {boards.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      }>
        <ul className="log">
          {actions.slice(0, limit).map(action => (
            <li key={action.id} className={action.ok ? '' : 'failed'}>
              <time>{time(action.at)}</time>
              <span className="actor">{who(action.actor)}</span>
              <span className="what">
                <b>{ACTIONS[action.kind] ?? action.kind}</b>
                {action.board && <span className="tag">{action.board}</span>}
                {action.detail && <span className="muted detail">{shortenLinks(action.detail)}</span>}
                {!action.ok && <span className="warn detail">失败：{action.message}</span>}
              </span>
            </li>
          ))}
        </ul>
        {actions.length > limit && <button className="link" onClick={() => setLimit(limit + 80)}>显示更多（还有 {actions.length - limit} 条）</button>}
      </Section>
      <Section title="锁记录">
        <ul className="log">
          {history.leases.slice(0, 40).map(lease => (
            <li key={lease.id}>
              <time>{time(lease.startedAt)}</time>
              <span className="actor">{who(lease.holder)}</span>
              <span className="what">
                <span className="tag">{lease.board}</span>
                <span className="muted detail">{lease.purpose}</span>
                <span className={lease.status === 'stolen' ? 'warn detail' : 'detail'}>{LEASE[lease.status]}{lease.status !== 'held' ? ` · ${time(lease.endedAt)}` : ''}{lease.status === 'stolen' && lease.endReason ? ` · ${lease.endReason}` : ''}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>
      {loadedUis(state).map(ui => ui.history && <ui.history key={ui.module} history={history} />)}
    </div>
  )
}

