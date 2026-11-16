/**
 * Discovery is the backend's: it reports the ways it can find a board, each with its own title, explanation and
 * fields, and runs the one chosen. Core checks only that an answer fits what the backend reported and the shape every
 * lab shares: one host, or one slot on it, and values for that method's fields. It never knows a method itself.
 */
import type { DiscoveryContext, DiscoveryMethod, DiscoveryValues } from '../shared/types.ts'
import { BoardError } from './errors.ts'

export const HOST = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/
// The backend names slots; this is only the `<host>/<slot>` shape every lab shares.
const SLOT = /^[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]+$/

/** A discovery context is one host, or one slot on it; both are backend-reported names. */
export function checkDiscoveryContext(context: DiscoveryContext): void {
  if (context.host && !HOST.test(context.host)) throw new BoardError('invalid', `主机名不合法：${context.host}`)
  if (context.slot && !SLOT.test(context.slot)) throw new BoardError('invalid', `槽位要写成 <主机>/<槽位>：${context.slot}`)
  if (context.slot && context.host && !context.slot.startsWith(`${context.host}/`)) throw new BoardError('invalid', `槽位 ${context.slot} 不在主机 ${context.host} 上`)
}

/** The method a call names, among the ones the backend reports for that context now. */
export function chosenMethod(methods: DiscoveryMethod[], id: string, lab: string): DiscoveryMethod {
  const method = methods.find(item => item.id === id)
  if (!method) throw new BoardError('invalid', `实验室 ${lab} 没有发现方法 ${id}`)
  return method
}

/** The values, checked against the method's own fields: unreported fields dropped, required ones filled, choices among
 * the backend's options. What the backend did not report cannot be passed to it. */
export function checkedValues(method: DiscoveryMethod, sent: DiscoveryValues | undefined): DiscoveryValues {
  const values: DiscoveryValues = {}
  for (const field of method.fields ?? []) {
    const value = sent?.[field.id]?.trim() ?? ''
    if (!value && field.required) throw new BoardError('invalid', `${method.title}需要${field.label}`)
    if (value && field.kind === 'choice' && field.options && !field.options.some(option => option.value === value))
      throw new BoardError('invalid', `${field.label}不是可选项：${value}`)
    if (value) values[field.id] = value
  }
  return values
}
