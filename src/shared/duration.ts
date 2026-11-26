/**
 * A length of time as a person types it on a command line: `90s`, `30m` (the default), `2h`. Used by the CLI's own
 * commands and by a module's (which may wait out a silence, hold a lock), so it lives where both reach it.
 */
export function parseDuration(text: string): number {
  const match = text.match(/^(\d+)(s|m|h)?$/)
  if (!match) throw new Error(`时长格式不对：${text}（例如 30m、2h、90s）`)
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? 'm') as 's' | 'm' | 'h']
}
