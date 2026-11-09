/**
 * The default boardlab page: board cards with locks and a queue, the online console, scanning, settings and history.
 * It is one UI on boardd's HTTP API (`GET /api` lists it); boardd can serve another (`serve --ui`) or none (`--no-ui`).
 * A distribution starts it with its modules' parts: `mountPage(uis)`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, identity, type PageState } from './api.ts'
import { registerModuleUis, type ModuleUi } from './extensions.ts'
import { Dialog, TABS, Tabs, who, type Prompt, type Run, type Tab } from './kit.tsx'
import { alertPerson, AttentionPanel } from './views/attention.tsx'
import { BoardsTab } from './views/boards.tsx'
import { Console } from './views/console.tsx'
import { HistoryTab } from './views/history.tsx'
import { RelayDialog } from './views/relay.tsx'
import { canScan, ScanTab } from './views/scan.tsx'
import { SettingsTab } from './views/settings.tsx'

// ---------- shell ----------

function useToasts() {
  const [toasts, setToasts] = useState<Array<{ id: number, text: string, error: boolean }>>([])
  const show = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random()
    setToasts(list => [...list.slice(-2), { id, text, error }])
    window.setTimeout(() => setToasts(list => list.filter(item => item.id !== id)), error ? 6000 : 3000)
  }, [])
  return { toasts, show }
}

/** One-click purposes for taking or queueing for a lock. */
const PURPOSES = ['临时调试', 'boardlab 调试', '临时开发任务']

function App() {
  const [state, setState] = useState<PageState | null>(null)
  const [tab, setTab] = useState<Tab>(() => (TABS.find(([key]) => `#${key}` === location.hash)?.[0]) ?? 'boards')
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [connected, setConnected] = useState(true)
  const { toasts, show } = useToasts()
  const you = useRef('')
  const [consoleBoard, setConsoleBoard] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try { const next = await api.state(); you.current = next.you; setState(next); setConnected(true) } catch { setConnected(false) }
    setRefreshKey(key => key + 1)
  }, [])

  useEffect(() => {
    void refresh()
    const source = new EventSource('api/events')
    let timer: number | undefined
    const soon = () => { window.clearTimeout(timer); timer = window.setTimeout(refresh, 150) }
    source.addEventListener('changed', soon)
    // Views that show a lab's free ports listen for news of them.
    source.addEventListener('lab-ports', event => {
      const data = JSON.parse((event as MessageEvent).data) as { lab: string, host?: string, added?: string[], removed?: string[] }
      window.dispatchEvent(new CustomEvent('boardlab:lab-ports', { detail: data }))
      // A cable plugged into a lab host is news for whoever is setting up a board.
      if (data.host && data.added?.length) show(`${data.host} 新接上 ${data.added.join('、')}（实验室 ${data.lab} 空闲端口）`)
      else if (data.host && data.removed?.length) show(`${data.host} 拔掉了 ${data.removed.join('、')}`)
    })
    source.addEventListener('scan', soon)
    source.addEventListener('lease-stolen', event => {
      const data = JSON.parse((event as MessageEvent).data)
      if (data.from === you.current) show(`${data.board} 的锁被 ${who(data.by)} 抢走：${data.reason}`, true)
      soon()
    })
    source.addEventListener('attention', event => {
      const data = JSON.parse((event as MessageEvent).data) as { board: string, message: string | null }
      if (data.message) alertPerson(data.board, data.message)
      soon()
    })
    source.addEventListener('lease-granted', event => {
      const data = JSON.parse((event as MessageEvent).data)
      if (data.holder === you.current) show(`轮到你了：已拿到 ${data.board} 的锁`)
      soon()
    })
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    const tick = window.setInterval(refresh, 30_000)
    return () => { source.close(); window.clearInterval(tick) }
  }, [refresh, show])

  useEffect(() => { history.replaceState(null, '', `#${tab}`) }, [tab])

  const run = useCallback<Run>(async (label, fn) => {
    setBusy(true)
    try { await fn(); show(label) } catch (error) { show((error as Error).message, true) }
    finally { setBusy(false); void refresh() }
  }, [refresh, show])

  const showError = useCallback((text: string) => show(text, true), [show])
  const closeConsole = useCallback(() => setConsoleBoard(null), [])
  const current = state?.boards.find(board => board.name === consoleBoard)
  const consoleOpen = !!current
  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="logo" aria-hidden="true" /><h1>开发板管理平台</h1></div>
        <Tabs label="页面" className="nav" value={tab} onChange={setTab} items={TABS.filter(([key]) => key !== 'scan' || !state || canScan({ state })).map(([key, label]) => ({
          key, label: <>{label}{key === 'scan' && state?.proposals.length ? <span className="count">{state.proposals.length}</span> : null}</>,
        }))} />
        <button className="me" onClick={() => setPrompt({ kind: 'identity' })} title="修改我的名字" data-testid="identity">
          <span className="avatar">{(state ? who(state.you) : '?').slice(0, 1).toUpperCase()}</span><span>{state ? who(state.you) : ''}</span>
        </button>
      </header>
      {!connected && <p className="banner">与 boardd 的连接中断，正在重试…</p>}
      <main className={consoleOpen ? 'with-console' : ''}>
        <div className="view" key={tab}>
          {!state ? <p className="muted">加载中…</p>
            : tab === 'boards' ? <BoardsTab state={state} busy={busy} onPrompt={setPrompt} onRun={run} onConsole={setConsoleBoard} onTab={setTab} />
            : tab === 'scan' ? <ScanTab state={state} onPrompt={setPrompt} onRun={run} />
            : tab === 'settings' ? <SettingsTab state={state} onPrompt={setPrompt} onRun={run} />
            : <HistoryTab refreshKey={refreshKey} state={state} />}
        </div>
      </main>
      {state && current && <Console key={current.name} board={current} state={state} onClose={closeConsole} onError={showError} />}
      {state && <AttentionPanel state={state} onRun={run} />}
      {prompt?.kind === 'relay' && <RelayDialog board={prompt.board} onClose={() => setPrompt(null)} onRun={run} />}
      {prompt && prompt.kind !== 'relay' && <PromptDialog prompt={prompt} onClose={() => setPrompt(null)} onRun={run} onIdentity={() => void refresh()} />}
      <div className="toasts" role="status">{toasts.map(toast => <div key={toast.id} className={`toast ${toast.error ? 'error' : ''}`}>{toast.text}</div>)}</div>
    </div>
  )
}

function PromptDialog({ prompt, onClose, onRun, onIdentity }: { prompt: Exclude<Prompt, { kind: 'relay' }>, onClose: () => void, onRun: Run, onIdentity: () => void }) {
  const [text, setText] = useState(prompt.kind === 'identity' ? identity.get() : '')
  const [sdk, setSdk] = useState(prompt.kind === 'sdkboot' ? prompt.board.lab?.sdks[0] ?? '' : '')
  const [method, setMethod] = useState<'load' | 'download'>('load')
  const [rename, setRename] = useState(false)
  const value = text.trim()
  const submit = async () => {
    onClose()
    switch (prompt.kind) {
      case 'lock': return onRun(`已拿到 ${prompt.board.name} 的锁`, () => api.lock(prompt.board.name, value))
      case 'queue': return onRun(`已排队 ${prompt.board.name}`, () => api.queue(prompt.board.name, value))
      case 'steal': return onRun(`已抢到 ${prompt.board.name} 的锁`, () => api.steal(prompt.board.name, value))
      case 'identity': identity.set(value); return onIdentity()
      case 'confirm': return onRun(`${prompt.title}：完成`, prompt.run)
      // The boot runs for minutes; the card shows its progress, and the result comes as a notice.
      // Reading the board takes a reset and a minute or two; the card shows when a person is needed.
      case 'refresh': return onRun(`${prompt.board.name}：已重新读取`, async () => { const result = await api.refresh(prompt.board.name, value ? { name: value } : { rename }); return result })
      case 'sdkboot': return onRun(`${prompt.board.name}：${method === 'download' ? '刷机' : '内存启动'} ${sdk} 完成`, () => api.bootSdk(prompt.board.name, sdk, method))
    }
  }
  const valid = prompt.kind === 'confirm' || (prompt.kind === 'sdkboot' ? !!sdk : false) || (prompt.kind === 'refresh' ? value === '' || /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(value) : false) || (prompt.kind === 'identity' ? value === '' || /^[A-Za-z0-9_.@-]{1,40}$/.test(value) : !!value)
  const board = 'board' in prompt ? prompt.board : null
  const title = { lock: `拿 ${board?.name} 的锁`, queue: `排队 ${board?.name}`, steal: `抢 ${board?.name} 的锁`, identity: '我是谁', sdkboot: `用 SDK 启动 ${board?.name}`, refresh: `重新读取 ${board?.name}`, confirm: prompt.kind === 'confirm' ? prompt.title : '' }[prompt.kind]
  const action = prompt.kind === 'confirm' ? prompt.action : { lock: '拿锁', queue: '排队', steal: '抢锁', identity: '保存', refresh: '重新读取', sdkboot: method === 'download' ? '刷机' : '内存启动' }[prompt.kind]
  const danger = prompt.kind === 'steal' || (prompt.kind === 'confirm' && prompt.danger)
  return (
    <Dialog title={title} onClose={onClose} actions={<>
      <button onClick={onClose}>取消</button>
      <button className={danger ? 'danger solid' : 'primary'} disabled={!valid} onClick={() => void submit()}>{action}</button>
    </>}>
      <form onSubmit={event => { event.preventDefault(); if (valid) void submit() }} className="form">
        {prompt.kind === 'lock' && <>
          <p className="muted">锁没有时间限制，用完请放锁；有人排队时会自动交给排在第一位的人。</p>
          <label>用途<input autoFocus value={text} onChange={event => setText(event.target.value)} placeholder="例如：调试 U-Boot 网络" /></label>
          <div className="quick">{PURPOSES.map(purpose => <button key={purpose} type="button" className={`chip ${text === purpose ? 'chip-on' : ''}`} onClick={() => setText(purpose)}>{purpose}</button>)}</div>
        </>}
        {prompt.kind === 'queue' && <>
          <p>现在由 <b>{who(prompt.board.lease?.holder ?? '')}</b> 使用（{prompt.board.lease?.purpose}）{prompt.board.waiters.length ? `，前面还有 ${prompt.board.waiters.length} 人` : ''}。轮到你时会自动把锁交给你。</p>
          <label>用途<input autoFocus value={text} onChange={event => setText(event.target.value)} placeholder="例如：跑一遍启动回归" /></label>
          <div className="quick">{PURPOSES.map(purpose => <button key={purpose} type="button" className={`chip ${text === purpose ? 'chip-on' : ''}`} onClick={() => setText(purpose)}>{purpose}</button>)}</div>
        </>}
        {prompt.kind === 'steal' && <>
          <p>当前由 <b>{who(prompt.board.lease?.holder ?? '')}</b> 使用（{prompt.board.lease?.purpose}）。抢锁会记录下来，原使用者会收到通知；排队顺序不变。</p>
          <label>原因<input autoFocus value={text} onChange={event => setText(event.target.value)} placeholder="写明为什么要抢" /></label>
        </>}
        {prompt.kind === 'identity' && <>
          <p className="muted">几个人用同一个页面时，各自填自己的名字，排队和锁才分得清。留空则使用 boardd 所在机器的用户。</p>
          <label>名字<input autoFocus value={text} onChange={event => setText(event.target.value)} placeholder="字母、数字、. _ - @" /></label>
        </>}
        {prompt.kind === 'confirm' && <p>{prompt.body}</p>}
        {prompt.kind === 'refresh' && <>
          <p className="muted">槽位里换了块板子时用：板子复位进下载模式，重新读它的型号、SoC，下载线换了口也会跟上；锁、槽位和历史都留着，不用删了重加。</p>
          <label>新名字<input autoFocus value={text} onChange={event => setText(event.target.value)} placeholder="留空保持现在的名字" /></label>
          <label className="switch"><input type="checkbox" checked={rename} disabled={!!value} onChange={event => setRename(event.target.checked)} />按读到的型号改名</label>
        </>}
        {prompt.kind === 'sdkboot' && <>
          <p className="muted">板子所在的主机自己去构建服务器取这个 SDK 编好的产物，按 SDK 的启动流程进下载模式、加载或烧录；进度显示在卡片上。由人复位的板子会在卡片上提示你按 RESET。</p>
          <label>SDK<select value={sdk} onChange={event => setSdk(event.target.value)}>{prompt.board.lab?.sdks.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>方式<select value={method} onChange={event => setMethod(event.target.value as 'load' | 'download')}>
            <option value="load">内存启动（fastboot 加载，不写板子）</option>
            <option value="download">刷机（烧录到板上存储）</option>
          </select></label>
        </>}
      </form>
    </Dialog>
  )
}

/** Start the page with the distribution's module UIs. */
export function mountPage(uis: ModuleUi[]) {
  registerModuleUis(uis)
  createRoot(document.getElementById('root')!).render(<App />)
}
