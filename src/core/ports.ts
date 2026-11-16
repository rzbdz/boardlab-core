/**
 * Choosing the free ports a manually reset board is made of: one download port and one serial console, both unbound.
 *
 * A person holding a board in download mode often knows only that: the board is the one new USB device. When exactly
 * one download port (and one console on that host) is free, that is the board. With several, nothing is guessed: the
 * error lists them so the person or agent names the one they mean.
 */
import type { LabSlots } from './backend.ts'
import { BoardError } from './errors.ts'

export interface PortRequest { host?: string | null, console?: string | null, usb?: string | null }
export interface PortChoice { host: string, console: string, usb: string }

const PORT = /^[A-Za-z0-9_.:/@-]{1,200}$/

/** Refuse a host, console or download port that cannot be passed to a backend; values left out are not checked. */
export function checkPorts(values: PortRequest): void {
  for (const [key, value] of Object.entries(values)) {
    if (value != null && value !== '' && !PORT.test(value)) throw new BoardError('invalid', `${key} 不合法：${value}`)
  }
}

/** Choose the host, console and download port for a manual board; never guesses between several candidates. */
export function choosePorts(hosts: LabSlots[], input: PortRequest): PortChoice {
  const wanted = { host: input.host?.trim() || undefined, console: input.console?.trim() || undefined, usb: input.usb?.trim() || undefined }
  const where = (host: string, usb: string, label: string) => `${host} ${usb}${label && label !== usb ? `（${label}）` : ''}`
  let host: string, usb: string
  if (wanted.usb) {
    const found = hosts.flatMap(item => item.usb.filter(port => port.id === wanted.usb).map(port => ({ host: item.host, label: port.label })))
      .filter(item => !wanted.host || item.host === wanted.host)
    if (!found.length) throw new BoardError('conflict', `${wanted.host ? `${wanted.host} 上的` : ''}下载口 ${wanted.usb}已经不空闲了（被占用、拔掉了，或板子没在下载模式），刷新后重新选`)
    if (found.length > 1) throw new BoardError('invalid', `多台主机都有下载口 ${wanted.usb}，请用 host 指定：${found.map(item => item.host).join('、')}`)
    host = found[0]!.host
    usb = wanted.usb
  } else {
    const free = hosts.filter(item => !wanted.host || item.host === wanted.host)
      .flatMap(item => item.usb.map(port => ({ host: item.host, id: port.id, label: port.label })))
    if (!free.length) throw new BoardError('conflict', `${wanted.host ? `${wanted.host} 上` : ''}没有未绑定的下载口：让板子进下载模式后刷新（按住 BOOT 再按 RESET），已登记的下载口不算`)
    if (free.length > 1) throw new BoardError('conflict', `有 ${free.length} 个未绑定的下载口：${free.map(item => where(item.host, item.id, item.label)).join('、')}。请保证此时只有一块板子处于下载模式，或用 usb 指定一个`)
    host = free[0]!.host
    usb = free[0]!.id
  }
  const entry = hosts.find(item => item.host === host)
  let console: string
  if (wanted.console) {
    if (!entry?.consoles.some(port => port.id === wanted.console)) throw new BoardError('conflict', `${host} 上的串口 ${wanted.console}已经不空闲了（被占用或拔掉了），刷新后重新选`)
    console = wanted.console
  } else {
    const free = entry?.consoles ?? []
    if (!free.length) throw new BoardError('conflict', `${host} 上没有空闲串口：把板子的串口线接上（或让主机认出它）后刷新，或用 console 指定`)
    if (free.length > 1) throw new BoardError('conflict', `${host} 上有 ${free.length} 个空闲串口：${free.map(port => `${port.id}（${port.label}）`).join('、')}。请用 console 指定板子的串口`)
    console = free[0]!.id
  }
  return { host, console, usb }
}
