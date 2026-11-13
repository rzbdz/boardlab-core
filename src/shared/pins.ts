/**
 * Header GPIO numbers people type into a discovery: `12,13`, `12，13`, `12、13`, one per line, `GPIO12`, `gpio_13`,
 * `P15`, `引脚16` — anything that is not a letter, digit or underscore separates, and the prefix may be attached with a
 * space, an underscore or not at all. Shared by the CLI, the page and the client.
 */
export function pinNumbers(text: string | null | undefined): number[] {
  const out: number[] = []
  for (const token of String(text ?? '').split(/[^0-9A-Za-z_一-鿿]+/)) {
    const found = /^(?:gpio|p|pin|引脚)[\s_-]*(\d+)$/i.exec(token) ?? /^(\d+)$/.exec(token)
    if (!found) continue
    const number = Number(found[1])
    if (Number.isInteger(number) && number >= 0 && number <= 999 && !out.includes(number)) out.push(number)
  }
  return out
}
