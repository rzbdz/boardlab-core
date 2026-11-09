/** The boards tab: a card per board with its lock, queue, relay and console, by backend, and the empty slots. */
import { useState } from 'react'
import type { Board, Chip } from '../../shared/types.ts'
import { api, type PageState } from '../api.ts'
import { MODE, Pill, Tabs, shortLink, time, who, type Prompt, type Run, type Tab } from '../kit.tsx'
import { LabPorts } from './labs.tsx'

// ---------- boards ----------

function ChipRow({ chip, many, lab }: { chip: Chip, many: boolean, lab: boolean }) {
  // A lab board's ports are named as its lab names them, on the lab's side.
  const offline = lab ? '实验室那边的串口没有连上' : chip.alias ? '未绑定设备' : '没有登记串口'
  return (
    <li>
      {many && <b className="die">{chip.die}</b>}
      <span className="port">
        <span className={`dot ${chip.online ? 'dot-ok' : 'dot-off'}`} title={chip.online ? '串口在线' : offline} />
        <span className="label">串口</span>
        <code>{chip.serialPath ? (lab ? chip.serialPath : shortLink(chip.serialPath)) : '—'}</code>
        {chip.alias && !chip.online && <em className="warn">未绑定设备</em>}
        {chip.online && chip.gateError && <em className="warn" title={chip.gateError}>闸门未生效</em>}
      </span>
      <span className="port">
        <span className="label">下载口</span>
        <code>{chip.downloadUsbPath ?? '—'}</code>
        {chip.usbId && <small>{chip.usbId}</small>}
      </span>
    </li>
  )
}

function BoardCard(props: { board: Board, state: PageState, busy: boolean, onPrompt: (prompt: Prompt) => void, onRun: Run, onConsole: (board: Board) => void }) {
  const { board, state } = props
  const mine = board.lease?.holder === state.you
  const place = board.waiters.findIndex(waiter => waiter.holder === state.you)
  const slot = state.slots.find(item => item.slot === board.slot)
  // A lab's listing can be a minute old, so its boards' consoles are offered and the lab is asked on opening.
  const online = board.chips.some(chip => chip.online) || (!!board.lab && board.chips.length > 0)
  const next = board.waiters[0]
  // An empty slot in a lab is only a console so far: no reset line or download port is known.
  const vacant = !!board.lab?.empty
  const canReset = board.lab ? !vacant : !!slot?.canReset
  const canFastboot = board.lab ? !vacant : !!slot?.canFastboot
  const labSlot = board.lab && board.slotRef ? board.slotRef.split('/').slice(1).join('/') : null
  return (
    <article className={`card ${mine ? 'card-mine' : ''} ${online ? 'card-console' : ''} ${vacant ? 'card-vacant' : ''}`} data-board={board.name}
      title={online ? '点卡片打开串口' : undefined}
      onClick={event => { if (online && !(event.target as HTMLElement).closest('button, a, input, select, textarea, label')) props.onConsole(board) }}>
      <header className="card-head">
        <div className="title">
          <span className="slot-tag" title={labSlot ? `也可以用槽位名操作：boardlab console ${labSlot}` : undefined}>{board.lab ? `实验室 ${board.lab.id} · ${labSlot ? `槽位 ${labSlot}` : board.lab.device}` : <>槽位 {board.slot ?? '—'}{slot?.label ? ` · ${slot.label}` : ''}</>}</span>
          <h3>{vacant ? `空槽位 ${labSlot ?? board.name}` : board.name}</h3>
          <p className="sub">{vacant ? '还没有登记板子，串口已经可以看和输入' : board.product ?? '型号未知'}{board.soc ? ` · ${board.soc.toUpperCase()}` : ''} · {MODE[board.mode]}{board.lab?.online ? ` · 系统在线${board.lab.ip ? ` ${board.lab.ip}` : ''}` : ''}</p>
        </div>
        {!board.lease && board.lab?.heldBy ? <Pill tone="warn">实验室占用</Pill> : !board.lease ? <Pill tone="ok">空闲</Pill> : mine ? <Pill tone="mine">你在使用</Pill> : <Pill tone="warn">使用中</Pill>}
      </header>

      <ul className="chips">
        {board.chips.map(chip => <ChipRow key={chip.die} chip={chip} many={board.chips.length > 1} lab={!!board.lab} />)}
        {!board.chips.length && <li className="muted">没有登记串口</li>}
      </ul>

      {board.lab?.heldBy && !board.lease && <p className="warn">实验室里正被 {board.lab.heldBy} 直接使用，拿锁要排队</p>}
      {board.lab?.attention && <div className="attention" role="alert">
        <b>需要人操作：</b>{board.lab.attention}
        {board.lab.canConfirm && <button className="primary" onClick={() => props.onRun('已告诉实验室', () => api.confirm(board.name))}>我已完成</button>}
      </div>}
      {board.lab?.progress && <p className="progress-line" aria-live="polite">启动中：{board.lab.progress}</p>}
      {board.lab?.mediaBoot && board.lab.mediaBoot.method !== 'reset' && <p className="muted small" title={board.lab.mediaBoot.why ?? undefined}>
        {board.lab.mediaBoot.available ? `下载模式是短接的：复位时经 ${board.lab.mediaBoot.method} 从板载介质启动` : '下载模式是短接的：复位后停在下载模式，只能从内存启动'}
      </p>}
      {board.lab?.leaseError && <p className="warn">实验室租约没有跟上锁：{board.lab.leaseError}</p>}
      {board.lease && (
        <div className="holder">
          <div className="line"><span className="label">使用者</span><b>{who(board.lease.holder)}</b><span className="muted">自 {time(board.lease.startedAt)}</span></div>
          <div className="purpose">{board.lease.purpose}</div>
        </div>
      )}
      {board.waiters.length > 0 && (
        <ol className="queue" aria-label="排队">
          {board.waiters.map((waiter, index) => (
            <li key={waiter.id} className={waiter.holder === state.you ? 'yours' : ''}>
              <span className="pos">{index + 1}</span><b>{who(waiter.holder)}</b><span className="muted">{waiter.purpose}</span>
            </li>
          ))}
        </ol>
      )}

      <footer className="actions">
        {!board.lease && !board.lab?.heldBy && <button className="primary" disabled={props.busy} onClick={() => props.onPrompt({ kind: 'lock', board })}>拿锁</button>}
        {!board.lease && board.lab?.heldBy && place < 0 && <button className="primary" disabled={props.busy} onClick={() => props.onPrompt({ kind: 'queue', board })}>排队</button>}
        {mine && <>
          <button disabled={props.busy || !canReset} onClick={() => props.onPrompt({ kind: 'confirm', title: `复位 ${board.name}`, body: '板子会立即重启。', action: '复位', run: () => api.reset(board.name) })}>复位</button>
          <button disabled={props.busy || !canFastboot} title={slot && !canFastboot ? '这个槽位只能复位' : undefined} onClick={() => props.onPrompt({ kind: 'confirm', title: `${board.name} 进入 fastboot`, body: '板子会重启进入 boot ROM 下载模式。', action: '进入 fastboot', run: () => api.fastboot(board.name) })}>fastboot</button>
          {!!board.lab?.sdks.length && <button disabled={props.busy || !!board.lab.progress} onClick={() => props.onPrompt({ kind: 'sdkboot', board })}>用 SDK 启动</button>}
          {board.lab && !vacant && state.labs.find(lab => lab.id === board.lab!.id)?.canRelay && <button disabled={props.busy} onClick={() => props.onPrompt({ kind: 'relay', board })}>继电器</button>}
          {board.lab?.canRefresh && <button disabled={props.busy} title="槽位里换了板子以后用：重新读型号、SoC 和下载口，不用删了重加" onClick={() => props.onPrompt({ kind: 'refresh', board })}>重新读取</button>}
          <button disabled={props.busy} onClick={() => props.onRun(next ? `已放锁，交给 ${who(next.holder)}` : '已放锁', () => api.unlock(board.name))}>{next ? `放锁并交给 ${who(next.holder)}` : '放锁'}</button>
        </>}
        {board.lease && !mine && (place >= 0
          ? <button disabled={props.busy} onClick={() => props.onRun('已退出排队', () => api.unqueue(board.name))}>退出排队 · 第 {place + 1} 位</button>
          : <button className="primary" disabled={props.busy} onClick={() => props.onPrompt({ kind: 'queue', board })}>排队</button>)}
        <button disabled={!online} title={online ? undefined : '没有在线的串口'} onClick={() => props.onConsole(board)}>控制台</button>
        {vacant && labSlot && state.labs.find(lab => lab.id === board.lab!.id)?.canDiscover && <button disabled={props.busy || !!state.labs.find(lab => lab.id === board.lab!.id)?.discovery?.running}
          onClick={() => props.onPrompt({ kind: 'confirm', title: `发现 ${labSlot} 上的板子`, action: '开始发现', danger: true,
            body: `逐个拉还没用过的复位线，看哪根让这个串口有反应、哪个下载口出现，找到就登记（以前用过的线先试）。会复位接在这些线上的板子。`,
            run: () => { void api.discoverLab(board.lab!.id, { slots: [labSlot] }).catch(() => {}); return Promise.resolve() } })}>发现这块板</button>}
        {board.lease && !mine && <button className="link danger push" disabled={props.busy} onClick={() => props.onPrompt({ kind: 'steal', board })}>抢锁</button>}
        {!board.lease && board.lab && !vacant && state.labs.find(lab => lab.id === board.lab!.id)?.canRemove && <button className="link danger push" disabled={props.busy} onClick={() => props.onPrompt({ kind: 'confirm', title: `从实验室移除 ${board.name}`, body: `实验室 ${board.lab!.id} 会忘掉 ${board.lab!.device}，要再用得重新发现或登记。`, action: '移除', danger: true, run: () => api.removeBoard(board.name) })}>移除</button>}
      </footer>
    </article>
  )
}


export function BoardsTab(props: { state: PageState, busy: boolean, onPrompt: (prompt: Prompt) => void, onRun: Run, onConsole: (board: string) => void, onTab: (tab: Tab) => void }) {
  const { state } = props
  const boards = state.boards.filter(board => !board.lab).sort((a, b) => (a.slot ?? Infinity) - (b.slot ?? Infinity))
  const labs = state.labs.filter(lab => lab.enabled || state.boards.some(board => board.lab?.id === lab.id))
  // A boardd that drives no hardware of its own (only labs, as on a server next to a lab's hosts) shows only its labs.
  const local = state.slots.length > 0 || boards.length > 0
  const [picked, setView] = useState<string | null>(null)
  const view = picked ?? (local || !labs.length ? 'boards' : `lab:${labs[0]!.id}`)
  const shown = view.startsWith('lab:') ? state.boards.filter(board => board.lab?.id === view.slice(4)) : boards
  const empty = state.slots.filter(slot => !state.boards.some(board => board.slot === slot.slot))
  const using = state.boards.filter(board => board.lease?.holder === state.you).length
  const queued = state.boards.filter(board => board.waiters.some(waiter => waiter.holder === state.you)).length
  if (!state.slots.length && !state.boards.length) {
    return (
      <div className="blank">
        <p>还没有槽位和板子。</p>
        <p className="muted">先到「设置」配置这台机器的槽位或开启实验室，再发现板子。</p>
        <button className="primary" onClick={() => props.onTab('settings')}>去设置</button>
      </div>
    )
  }
  return (
    <>
      <div className="toolbar">
        <Tabs label="槽位" value={view} onChange={setView} items={[
          ...(local ? [{ key: 'boards', label: <>本机槽位<span className="num">{boards.length}</span></> }] : []),
          ...labs.flatMap(lab => [
            { key: `lab:${lab.id}`, label: <>实验室 {lab.id}<span className="num">{state.boards.filter(board => board.lab?.id === lab.id).length}</span></> },
            ...(lab.canBind && lab.enabled ? [{ key: `ports:${lab.id}`, label: <>{lab.id} 空闲端口</> }] : []),
          ]),
          ...(local ? [{ key: 'empty', label: <>空槽位<span className="num">{empty.length}</span></> }] : []),
        ]} />
        <div className="summary">
          <span><b>{using}</b> 块你在使用</span>
          <span><b>{queued}</b> 块你在排队</span>
          {state.proposals.length > 0 && <button className="link" onClick={() => props.onTab('scan')}>{state.proposals.length} 条扫描建议待确认</button>}
        </div>
      </div>
      <div className="view" key={view}>
        {view.startsWith('ports:') && <LabPorts lab={view.slice(6)} onRun={props.onRun} />}
        {view !== 'empty' && !view.startsWith('ports:') && (shown.length
          ? <div className="grid">{shown.map(board => <BoardCard key={board.name} board={board} state={state} busy={props.busy} onPrompt={props.onPrompt} onRun={props.onRun} onConsole={board => props.onConsole(board.name)} />)}</div>
          : view === 'boards'
            ? <div className="blank"><p>还没有发现板子。</p><button className="primary" onClick={() => props.onTab('scan')}>去扫描</button></div>
            : <div className="blank"><p>这个实验室还没有列出板子。</p><button className="primary" onClick={() => props.onTab('settings')}>去设置</button></div>)}
        {view === 'empty' && (empty.length
          ? (
            <ul className="empty-list">
              {empty.map(slot => (
                <li key={slot.slot}>
                  <span className="slot-tag">槽位 {slot.slot}</span>
                  {slot.kind === 'script' && <span className="tag">{slot.label ?? '自定义'}{slot.canFastboot ? '' : ' · 只能复位'}</span>}
                  <span className="grow muted">扫描没有在这个槽位发现板子</span>
                </li>
              ))}
              <li className="empty-foot"><span className="muted grow">接上板子后重新扫描即可登记。</span><button onClick={() => props.onTab('scan')}>去扫描</button></li>
            </ul>
          )
          : <div className="blank"><p>所有槽位都有板子。</p></div>)}
      </div>
    </>
  )
}
