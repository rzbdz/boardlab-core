/** Labs on the page: their settings, their free ports, and finding new boards in them. */
import { useCallback, useEffect, useState } from 'react'
import type { LabPorts as LabPortsView, LabSettings } from '../../shared/types.ts'
import { api, type PageState } from '../api.ts'
import { Pill, Section, time, who, type Prompt, type Run } from '../kit.tsx'

/**
 * A lab's free ports: serial consoles and download ports no board uses yet, as a new cable shows up. Binding a console
 * and a download port makes a board reset by a person, for temporary debugging without naming anything first.
 */
export function LabPorts({ lab, onRun }: { lab: string, onRun: Run }) {
  const [ports, setPorts] = useState<LabPortsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState<Record<string, { console: string, usb: string, name: string }>>({})
  // What boardd heard last shows at once; it asks the lab again in the background and says so when the answer is in.
  const load = useCallback((fresh = false) => api.labPorts(lab, fresh).then(next => { setPorts(next); setError(null) }, failure => setError((failure as Error).message)), [lab])
  useEffect(() => {
    void load()
    const changed = (event: Event) => { if ((event as CustomEvent).detail?.lab === lab) void load() }
    window.addEventListener('boardlab:lab-ports', changed)
    return () => window.removeEventListener('boardlab:lab-ports', changed)
  }, [load, lab])
  if (!ports) return error ? <div className="blank"><p className="warn">{error}</p><button onClick={() => void load()}>重试</button></div> : <p className="muted">正在读取空闲端口…</p>
  const hosts = ports.hosts
  return (
    <div className="stack">
      <p className="muted">还没有板子用的串口和下载口（新接上的线会出现在这里）。选一个串口和一个下载口登记成由人复位的板子，就能拿锁、看串口、内存启动；复位时按提示操作再点「我已完成」。要让实验室自己认出接线，用「扫描」。</p>
      <div className="actions">
        <span className="muted">{ports.at ? `更新于 ${time(ports.at)}` : '还没有问过实验室'}{ports.refreshing ? ' · 正在刷新…' : ''}</span>
        {ports.error && <span className="warn">上次没问到：{ports.error}</span>}
        <button className="push" disabled={ports.refreshing} onClick={() => void load(true)}>刷新</button>
      </div>
      {!hosts.length && !ports.refreshing && <p className="muted">实验室没有报告主机。</p>}
      {hosts.map(host => {
        const choice = pick[host.host] ?? { console: host.consoles[0]?.id ?? '', usb: host.usb[0]?.id ?? '', name: '' }
        const set = (change: Partial<typeof choice>) => setPick({ ...pick, [host.host]: { ...choice, ...change } })
        return (
          <Section key={host.host} title={host.host} extra={<span className="muted">{host.consoles.length} 个串口 · {host.usb.length} 个下载口</span>}>
            {!host.consoles.length && !host.usb.length ? <p className="muted">没有空闲端口。</p> : (
              <form className="form-grid" onSubmit={event => { event.preventDefault(); void onRun('已登记', () => api.bindLab(lab, { host: host.host, console: choice.console, usb: choice.usb, name: choice.name.trim() || undefined }).then(() => load())) }}>
                <label>串口<select value={choice.console} onChange={event => set({ console: event.target.value })}>{host.consoles.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <label>下载口<select value={choice.usb} onChange={event => set({ usb: event.target.value })}>{host.usb.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <label className="span">板名<input value={choice.name} onChange={event => set({ name: event.target.value })} placeholder="留空用 tmp-<主机>-<串口>" /></label>
                <div className="actions span"><button className="primary" disabled={!choice.console || !choice.usb}>登记为由人复位的板子</button></div>
              </form>
            )}
          </Section>
        )
      })}
    </div>
  )
}

/**
 * A lab that finds boards itself . What it finds joins the proposals below; nothing is registered
 * until a person applies it.
 */
export function LabScan({ lab, state, onPrompt }: { lab: LabSettings, state: PageState, onPrompt: (prompt: Prompt) => void }) {
  const [picked, setHost] = useState<string | null>(null)
  // The lab's hosts can arrive after the page first draws; until one is picked, the first is the choice.
  const host = picked ?? lab.hosts[0] ?? ''
  const held = state.boards.filter(board => board.lab?.id === lab.id && (board.lease || board.lab.heldBy))
  // Finding boards can take many minutes; it runs on in boardd and reports its progress here.
  const discover = (options: { human?: boolean, host?: string }) => { void api.discoverLab(lab.id, options).catch(() => {}); return Promise.resolve() }
  const rebuild = (target: string) => { void api.rebuildLab(lab.id, target).catch(() => {}); return Promise.resolve() }
  // What a rebuild of the chosen host forgets: the boards registered there (empty slots are just consoles).
  const onHost = state.boards.filter(board => board.lab?.id === lab.id && board.slotRef?.startsWith(`${host}/`))
  const heldOnHost = onHost.filter(board => board.lease || board.lab?.heldBy)
  const running = !!lab.discovery?.running
  return (
    <Section title={`实验室 ${lab.id} · 发现板子`} extra={running ? <Pill tone="mine">进行中</Pill> : null}>
      <p className="muted">{lab.kind}。找到的板子先列成下面的改动建议，确认（可以改名）后才登记到实验室里。</p>
      {held.length > 0 && <p className="warn">{held.map(board => `${board.name} 正被 ${who(board.lease?.holder ?? board.lab!.heldBy!)} 使用`).join('；')}。发现板子会复位板子，有板子被用着时不会开始。</p>}
      <div className="scan-modes">
        <div className="scan-mode">
          <b>接了复位线的板子</b>
          <p className="muted">逐个拉还没用过的复位线，看哪个串口有反应、哪个下载口出现，会复位接在这些线上的板子。</p>
          <div className="actions">
            <button className="primary" disabled={running || held.length > 0} onClick={() => onPrompt({ kind: 'confirm', title: `在实验室 ${lab.id} 发现板子`, body: '逐个拉还没用过的复位线、看串口和 USB，会复位接在这些线上的板子。', action: '开始发现', danger: true, run: () => discover({}) })}>开始发现</button>
          </div>
        </div>
        {lab.canRebuild && <div className="scan-mode">
          <b>重新布线以后：重建一台主机</b>
          <p className="muted">把串口、USB 线重新插过、换了口以后用：忘掉这台主机上发现过的板子和槽位，按现在插着的串口重新建槽位，再逐个找板子（以前用过的复位线先试，找到的板子沿用原来的名字），找到一块登记一块。主机上任何板子被用着时不会开始。</p>
          <div className="actions">
            {lab.hosts.length
              ? <select value={host} onChange={event => setHost(event.target.value)} aria-label="重建的主机">{lab.hosts.map(item => <option key={item} value={item}>{item}</option>)}</select>
              : <input className="host-input" value={host} onChange={event => setHost(event.target.value)} placeholder="主机名" aria-label="重建的主机" />}
            <button className="danger" disabled={running || heldOnHost.length > 0 || !host.trim()} title={heldOnHost.length ? `${heldOnHost.map(board => board.name).join('、')} 正被使用` : undefined}
              onClick={() => onPrompt({ kind: 'confirm', title: `重建 ${host.trim()}`, action: '重建', danger: true,
                body: `会忘掉 ${host.trim()} 上的 ${onHost.filter(board => !board.lab?.empty).map(board => board.name).join('、') || '（没有登记的板子）'} 和它的所有槽位，按现在的接线重新发现板子，会复位接在复位线上的所有板子。站点配置里写死的板子不受影响。`,
                run: () => rebuild(host.trim()) })}>重建</button>
          </div>
        </div>}
        <div className="scan-mode">
          <b>没接复位线的板子（人工复位）</b>
          <p className="muted">选板子所在的主机，开始后按提示一次让一块还没登记的板子进下载模式，实验室把串口和下载口配成一对。</p>
          <div className="actions">
            {/* A list input filters its suggestions by what is typed, so a filled-in host hid every other one. */}
            {lab.hosts.length
              ? <select value={host} onChange={event => setHost(event.target.value)} aria-label="人工发现的主机">{lab.hosts.map(item => <option key={item} value={item}>{item}</option>)}</select>
              : <input className="host-input" value={host} onChange={event => setHost(event.target.value)} placeholder="主机名" aria-label="人工发现的主机" />}
            <button disabled={running || held.length > 0 || !host.trim()} onClick={() => onPrompt({ kind: 'confirm', title: `在 ${host.trim()} 上人工发现板子`, body: '给没接复位线的板子用：开始后按这里显示的提示，一次只让一块还没登记的板子进下载模式（按 RESET，下载模式不是默认的板子同时按住 BOOT），实验室把有反应的串口和新出现的下载口配成一对。一轮里什么都没发生就结束。', action: '开始', run: () => discover({ human: true, host: host.trim() }) })}>开始人工发现</button>
          </div>
        </div>
      </div>
      {lab.discovery && <p className={lab.discovery.running ? 'warn' : 'muted'} data-testid={`lab-${lab.id}-discovery`}>{lab.discovery.running ? '进行中：' : '上次：'}{lab.discovery.line} · {time(lab.discovery.at)}</p>}
    </Section>
  )
}

/** A remote lab: whether boardd uses it, and the access its boards are reached with. */
export function LabSection({ lab, onRun, onPrompt }: { lab: LabSettings, onRun: Run, onPrompt: (prompt: Prompt) => void }) {
  const fields = lab.fields
  const [enabled, setEnabled] = useState(lab.enabled)
  const [url, setUrl] = useState(lab.url ?? '')
  const [username, setUsername] = useState(lab.username ?? '')
  const [password, setPassword] = useState('')
  const [jump, setJump] = useState(lab.jump ?? '')
  const [devices, setDevices] = useState(lab.devices ?? '')
  const save = () => onRun(enabled ? '已保存，实验室的板子已列出' : lab.enabled ? '已关闭实验室' : '已保存', async () => {
    await api.configureLab({ id: lab.id, enabled, url, username, password, jump, devices })
    setPassword('')
  })
  const status = !lab.enabled ? <Pill tone="warn">未开启</Pill> : lab.verifiedAt ? <Pill tone={lab.verifyOk ? 'ok' : 'err'}>{lab.verifyOk ? '连接正常' : '连接失败'}</Pill> : null
  return (
    <Section title={`实验室 ${lab.id}`} extra={status}>
      <p className="muted">{lab.kind}。{lab.about}</p>
      <form className="form-grid" onSubmit={event => { event.preventDefault(); void save() }}>
        <label className="switch span"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />开启 {lab.id} 实验室</label>
        {fields.url && <label>{fields.url.label}<input value={url} onChange={event => setUrl(event.target.value)} placeholder={fields.url.placeholder ?? undefined} required={enabled && fields.url.required} /></label>}
        {fields.username && <label>{fields.username.label}<input value={username} onChange={event => setUsername(event.target.value)} placeholder={fields.username.placeholder ?? undefined} autoComplete="off" required={enabled && fields.username.required} /></label>}
        {fields.password && <label>{fields.password.label}
          <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password"
            placeholder={lab.hasPassword ? '已保存（不显示，留空则不修改）' : fields.password.placeholder ?? undefined} required={enabled && fields.password.required && !lab.hasPassword} />
        </label>}
        {fields.jump && <label>{fields.jump.label}<input value={jump} onChange={event => setJump(event.target.value)} placeholder={lab.defaultJump ? `留空用 ${lab.defaultJump}` : fields.jump.placeholder ?? undefined} /></label>}
        <label className="span">只用这些板子<input value={devices} onChange={event => setDevices(event.target.value)} placeholder="留空列出全部；例如 sub0-* sub1-*" /></label>
        <div className="actions span">
          <button className="primary">{enabled ? '保存并列出板子' : '保存'}</button>
          <button type="button" disabled={!lab.enabled} onClick={() => onRun('已重新验证', () => api.testLab(lab.id))}>重新验证并刷新</button>

        </div>
        {lab.enabled && lab.verifiedAt && <p className={`span ${lab.verifyOk ? 'muted' : 'warn'}`} data-testid={`lab-${lab.id}-verify`}>{lab.verifyMessage} · {time(lab.verifiedAt)}</p>}
        {lab.enabled && lab.syncedAt && <p className={`span ${lab.syncOk ? 'muted' : 'warn'}`} data-testid={`lab-${lab.id}-sync`}>{lab.syncMessage} · {time(lab.syncedAt)}</p>}
      </form>
    </Section>
  )
}
