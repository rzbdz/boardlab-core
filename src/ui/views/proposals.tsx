/** Proposed inventory changes from scans and discoveries, applied or rejected by a person. */
import { useState } from 'react'
import type { Proposal } from '../../shared/types.ts'
import { api } from '../api.ts'
import { KIND, Section, shortenLinks, type Run } from '../kit.tsx'

/** A new board on a slot that can only reset has no product to be named after, so the person names it. */
const needsName = (item: Proposal) => item.kind === 'new-board' && !item.change.name

export function ProposalList({ proposals, onRun }: { proposals: Proposal[], onRun: Run }) {
  const [names, setNames] = useState<Record<string, string>>({})
  if (!proposals.length) return null
  const unnamed = proposals.filter(item => needsName(item) && !names[item.id]?.trim())
  return (
    <Section title={`清单改动建议 · ${proposals.length}`} extra={
      <div className="actions">
        <button onClick={() => onRun('已全部拒绝', () => api.proposals(proposals.map(item => item.id), 'reject'))}>全部拒绝</button>
        <button className="primary" disabled={unnamed.length > 0} title={unnamed.length ? '先给新板子填板名' : undefined}
          onClick={() => onRun('已全部应用', () => api.proposals(proposals.map(item => item.id), 'apply', names))}>全部应用</button>
      </div>
    }>
      <ul className="proposals">
        {proposals.map(item => (
          <li key={item.id}>
            <span className="kind">{KIND[item.kind]}</span>
            <span className="grow">{shortenLinks(item.summary)}</span>
            {(needsName(item) || !!item.change.lab) && (
              <input className="board-name" value={names[item.id] ?? ''} onChange={event => setNames({ ...names, [item.id]: event.target.value })}
                placeholder={item.change.lab ? String(item.change.name) : '板名，例如 mijia-dev'} aria-label={item.change.lab ? '实验室里的板名' : `槽位 ${item.slot} 的板名`} />
            )}
            <span className="actions">
              <button onClick={() => onRun('已拒绝', () => api.proposals([item.id], 'reject'))}>拒绝</button>
              <button className="primary" disabled={needsName(item) && !names[item.id]?.trim()}
                onClick={() => onRun('已应用', () => api.proposals([item.id], 'apply', names[item.id]?.trim() ? { [item.id]: names[item.id]!.trim() } : undefined))}>应用</button>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  )
}
