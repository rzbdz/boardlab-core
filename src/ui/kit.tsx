/** The page's small pieces: formatting, labels, and the components every view uses. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Board, Lease, Proposal, Scan } from '../shared/types.ts'

export type Tab = 'boards' | 'scan' | 'settings' | 'history'
export const TABS: Array<[Tab, string]> = [['boards', '板子'], ['scan', '扫描'], ['settings', '设置'], ['history', '历史']]

export const pad = (n: number) => String(n).padStart(2, '0')
/** `10/29 09:40:05`, short enough to stay on one line. */
export function time(iso: string | null, withDate = true) {
  if (!iso) return '—'
  const d = new Date(iso)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return withDate ? `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${clock}` : clock
}
/** `/dev/serial/by-path/pci-…-usb-0:6.4.2:1.0-port0` → `USB 6.4.2`. */
export function shortLink(link: string) {
  const port = link.match(/-usb-\d+:([\d.]+):/)?.[1]
  return port ? `USB ${port}` : link.split('/').at(-1)!
}
export const shortenLinks = (text: string) => text.replace(/\/dev\/serial\/by-path\/\S+/g, link => shortLink(link))
/** `user:troy` → `troy`; other holder kinds keep their prefix so agents stay recognisable. */
export const who = (holder: string) => holder.startsWith('user:') ? holder.slice(5) : holder

export const ACTIONS: Record<string, string> = {
  lock: '拿锁', unlock: '放锁', queue: '排队', unqueue: '退出排队', steal: '抢锁', reset: '复位', fastboot: '进入 fastboot',
  send: '串口输入', stage: '加载镜像', boot: '内存启动', scan: '开始扫描', 'scan-end': '扫描结束',
  'scan-cancel': '取消扫描', 'proposal-apply': '应用建议', 'proposal-reject': '拒绝建议', 'ha-config': '配置 HA', 'ha-test': '验证 HA',
  'slots-confirm': '确认槽位', 'slots-sync': '同步槽位', 'slot-save': '保存自定义槽位', 'slot-remove': '删除自定义槽位', image: '登记镜像', 'image-remove': '移除镜像', add: '登记板子', remove: '移除板子', edit: '编辑板子',
  'lab-config': '配置实验室', 'lab-test': '验证实验室', 'lab-sync': '实验室板子变动', 'lab-lease': '实验室租约', 'lab-discover': '实验室发现板子', 'lab-bind': '用空闲端口登记', 'lab-ports': '实验室接线变化', confirm: '确认人工操作', 'console-input': '串口交互', flash: '刷机', sdk: 'SDK 操作', relay: '继电器', refresh: '重新读取板子', 'lab-slot': '槽位换板',
}
export const MODE: Record<Board['mode'], string> = { unknown: '状态未知', normal: '已复位', resetting: '复位中', fastboot: 'fastboot 模式' }
export const KIND: Record<Proposal['kind'], string> = { 'new-board': '新板', 'replace-board': '换板', 'serial-moved': '串口', 'download-moved': '下载口', 'product-changed': '型号', 'slot-empty': '空槽位' }
export const STATUS: Record<Scan['status'], string> = { running: '进行中', done: '完成', failed: '失败', cancelled: '已取消' }
export const LEASE: Record<Lease['status'], string> = { held: '使用中', released: '已释放', stolen: '被抢' }

export type Run = (label: string, fn: () => Promise<unknown>) => Promise<void>
export type Prompt =
  | { kind: 'lock', board: Board }
  | { kind: 'queue', board: Board }
  | { kind: 'steal', board: Board }
  | { kind: 'identity' }
  | { kind: 'sdkboot', board: Board }
  | { kind: 'relay', board: Board }
  | { kind: 'refresh', board: Board }
  | { kind: 'confirm', title: string, body: string, action: string, danger?: boolean, run: () => Promise<unknown> }

// ---------- small pieces ----------

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'mine' | 'err', children: ReactNode }) {
  return <span className={`pill pill-${tone}`}><i />{children}</span>
}

export function Dialog(props: { title: string, children: ReactNode, onClose: () => void, actions: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose() }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={props.title}>
        <h2>{props.title}</h2>
        <div className="dialog-body">{props.children}</div>
        <div className="dialog-actions">{props.actions}</div>
      </div>
    </div>
  )
}

export function Section(props: { title: string, extra?: ReactNode, children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-head"><h3>{props.title}</h3>{props.extra}</header>
      {props.children}
    </section>
  )
}

/** Segmented tabs whose dark selection slides to the chosen item. */
export function Tabs<T extends string>(props: { items: Array<{ key: T, label: ReactNode }>, value: T, onChange: (key: T) => void, label: string, className?: string }) {
  const root = useRef<HTMLDivElement>(null)
  const [mark, setMark] = useState<{ left: number, width: number } | null>(null)
  useLayoutEffect(() => {
    const measure = () => {
      const active = root.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      if (active) setMark({ left: active.offsetLeft, width: active.offsetWidth })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root.current!)
    return () => observer.disconnect()
  }, [props.value, props.items.length])
  return (
    <div ref={root} className={`tabs ${props.className ?? ''}`} role="tablist" aria-label={props.label}>
      {mark && <span className="tabs-mark" style={{ transform: `translateX(${mark.left}px)`, width: mark.width }} aria-hidden="true" />}
      {props.items.map(item => (
        <button key={item.key} role="tab" aria-selected={props.value === item.key} className={props.value === item.key ? 'active' : ''} onClick={() => props.onChange(item.key)}>{item.label}</button>
      ))}
    </div>
  )
}

