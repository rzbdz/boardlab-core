/**
 * Labs added at runtime keep their `kind` in boardd's settings (`labs.added`). A module's id can change between
 * versions; a lab someone added by the old name must not turn into a lab nobody offers, so a module that renamed
 * itself says so once, in its catalog entry's `was`, and the stored kind is moved before any kind is offered.
 *
 * `was` is read from the catalog by the caller (`startBoardd`): this file knows no module.
 */
interface Added { id: string, kind: string }

/** What a settings store looks like to this file: a boardd kernel, or a database read before one exists. */
export interface Settings { setting(key: string): string | null, setSetting(key: string, value: string | null): void }

/** The settings in a database, as `Kernel` reads them — for a boardd that moves stored labs before its kernel exists. */
export function databaseSettings(db: { prepare(sql: string): { get(...args: unknown[]): unknown, run(...args: unknown[]): unknown } }): Settings {
  return {
    setting: key => {
      const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value?: unknown } | undefined
      return row ? String(row.value) : null
    },
    setSetting: (key, value) => {
      if (value === null) db.prepare('DELETE FROM settings WHERE key=?').run(key)
      else db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
    },
  }
}

/** The labs added at runtime, as the settings hold them. */
export function addedLabs(kernel: Pick<Settings, 'setting'>): Added[] {
  try {
    const parsed = JSON.parse(kernel.setting('labs.added') ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

/**
 * Move every stored lab of an old kind to the kind that replaced it (`moves`: old id -> new id). Idempotent: a second
 * start finds nothing to move. Returns what moved, for the caller to report.
 */
export function moveAddedLabs(kernel: Settings, moves: Record<string, string>): Array<{ id: string, from: string, to: string }> {
  const labs = addedLabs(kernel)
  const moved: Array<{ id: string, from: string, to: string }> = []
  const next = labs.map(lab => {
    const to = moves[lab.kind]
    if (!to) return lab
    moved.push({ id: lab.id, from: lab.kind, to })
    return { id: lab.id, kind: to }
  })
  if (moved.length) kernel.setSetting('labs.added', JSON.stringify(next))
  return moved
}
