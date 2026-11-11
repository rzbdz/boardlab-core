/** Small helpers shared by the core and modules. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/**
 * Holders are `user:<name>` (a person), or `<kind>:<task>` for an agent or tool acting for one: `claude:`, `codex:`,
 * `opencode:`, `dsh:`, `workspace:` and the like. Boards held by `boardlab:` are held by another boardd for someone.
 */
export const HOLDER = /^[a-z][a-z0-9-]{0,31}:[^\s]{1,120}$/
export const BOARD_NAME = /^[A-Za-z0-9_.-]{1,64}$/
export const isHuman = (holder: string) => holder.startsWith('user:')
/** Printable text only: ANSI sequences and control bytes go, so a K3 ROM banner's leading NULs cannot cut stored text short. */
export const stripAnsi = (text: string) => text.replace(ANSI, '').replace(/\r(?!\n)/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
/** A non-empty string column, or null. */
export const str = (value: unknown) => typeof value === 'string' && value ? value : null
export type Row = Record<string, any>
