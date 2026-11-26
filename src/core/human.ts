/**
 * The record of what asked a person for work, and how it ended: one archive for every way a request reaches a boardd.
 * An agent files one through a module's API; the core's relay files one when a backend stops and waits for somebody
 * (`ACTION NEEDED: press RESET …`). Both are the same row, and a second source — a lab's own helpdesk pushing asks in —
 * adds a caller, not a table.
 *
 * The archive lives in the core because more than the module reads it: a backend's attention reaches it through the
 * relay, and a module that lives outside this build (a market) reads it through the SDK. Nothing here knows what a
 * "board" or a "provider" is: a source says who asked, what for, and which thing it is about.
 */
import type { Kernel } from './kernel.ts'
import { str, type Row } from './text.ts'

export const STATUSES = ['open', 'done', 'canceled'] as const
export type HumanStatus = typeof STATUSES[number]

/** One request for a person, as stored and as every reader sees it. */
export interface HumanRequest {
  id: number
  at: string
  updatedAt: string
  /** Who asked (`claude:…`, `user:…`, a source such as `boardctrl`). */
  actor: string
  /** A short label for the kind of work (plug, unplug, connect, press, …), free text. */
  kind: string
  title: string
  /** What to do, in the asker's words: which cable, which board, what to watch for. */
  body: string
  /** Whatever the asker attached: JSON, or null. */
  context: unknown | null
  status: HumanStatus
  /** How it ended, and who ended it. */
  resolution: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  /**
   * The thing the ask is about, stable per source (`board:<name>`, `slot:<host>/<slot>`): a second ask about
   * the same thing while the first is open updates it rather than filing another, and when the thing stops needing a
   * person the source closes its ask through this key (`close`).
   */
  subject: string | null
  /** Where the request came from (`ask`, `relay`, a module's id), so a history can say how it was made. */
  source: string
}

/** What a source gives to file a request; everything but `title` has a sensible default. */
export interface HumanAsk {
  actor: string
  title: string
  body?: string
  kind?: string
  context?: unknown
  /** The same retry key the API uses: one open request per actor and key. */
  key?: string | null
  /** The thing it is about, stable per source (see `subject`); one open request per subject. */
  subject?: string | null
  source?: string
}

export interface HumanInbox { open: number, items: HumanRequest[] }

const TABLE = `
  CREATE TABLE IF NOT EXISTS human_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL, updated_at TEXT NOT NULL, actor TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'task', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    context TEXT, task_key TEXT, status TEXT NOT NULL DEFAULT 'open',
    resolution TEXT, resolved_at TEXT, resolved_by TEXT,
    subject TEXT, source TEXT NOT NULL DEFAULT 'ask'
  );
  CREATE INDEX IF NOT EXISTS human_requests_status ON human_requests(status, id);
  CREATE UNIQUE INDEX IF NOT EXISTS human_requests_key ON human_requests(actor, task_key)
    WHERE task_key IS NOT NULL AND status = 'open';
`
/**
 * What an older boardd's table lacks: its rows came from `boardlab ask` only, so `source` is 'ask'. The columns are
 * added in place (`ALTER TABLE`), so a boardd that saw the previous shape keeps its history.
 */
const ADDED: Array<[string, string, string]> = [
  ['human_requests', 'subject', 'TEXT'],
  ["human_requests", 'source', "TEXT NOT NULL DEFAULT 'ask'"],
]

export const isStatus = (value: string): value is HumanStatus => (STATUSES as readonly string[]).includes(value)
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** How a title or a body is cut to one line for a list: line endings normalised, surrounding space gone. */
export const cleaned = (text: string) => text.replace(/\r\n?/g, '\n').trim()

const toRequest = (row: Row): HumanRequest => ({
  id: Number(row.id), at: String(row.at), updatedAt: String(row.updated_at), actor: String(row.actor),
  kind: String(row.kind), title: String(row.title), body: String(row.body),
  context: row.context === null || row.context === undefined ? null : JSON.parse(String(row.context)),
  status: row.status as HumanStatus,
  resolution: str(row.resolution), resolvedAt: str(row.resolved_at), resolvedBy: str(row.resolved_by),
  subject: str(row.subject), source: row.source === null || row.source === undefined ? 'ask' : String(row.source),
})

/**
 * The archive on one boardd's database. `human` makes it in its setup and keeps it; a source (`relay`, another
 * module) gets the same object and files asks through it, so every request lands in one history.
 */
export interface HumanArchive {
  file(ask: HumanAsk): HumanRequest
  /** End the ask `id`: done or canceled, or `open` to reopen it. Returns it, or null when there is none. */
  resolve(id: number, status: HumanStatus, by: string, note?: string | null): HumanRequest | null
  /** End the open ask about `subject` (from a source): done or canceled. Returns it, or null when none was open. */
  close(subject: string, status: 'done' | 'canceled' | 'open', by: string, note?: string | null): HumanRequest | null
  /** The subject of that ask now says the board is called `to`: a person renamed it. */
  rename(from: string, to: string): void
  find(id: number): HumanRequest | null
  /** Requests by status (`null`: every one), newest first. */
  list(status: HumanStatus | null, limit?: number): HumanRequest[]
  inbox(shown?: number): HumanInbox
  count(): number
  isStatus(value: string): value is HumanStatus
}

export function humanArchive(kernel: Kernel): HumanArchive {
  kernel.schema(TABLE, ADDED)
  const find = (id: number): HumanRequest | null => {
    const row = kernel.db.prepare('SELECT * FROM human_requests WHERE id=?').get(id) as Row | undefined
    return row ? toRequest(row) : null
  }
  const list = (status: HumanStatus | null, limit = 100): HumanRequest[] => (status
    ? kernel.db.prepare('SELECT * FROM human_requests WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
    : kernel.db.prepare('SELECT * FROM human_requests ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(toRequest)
  const count = () => Number((kernel.db.prepare(`SELECT count(*) AS n FROM human_requests WHERE status='open'`).get() as Row | undefined)?.n ?? 0)
  const openByActorKey = (actor: string, key: string): HumanRequest | null => {
    const row = kernel.db.prepare(`SELECT * FROM human_requests WHERE actor=? AND task_key=? AND status='open' ORDER BY id DESC LIMIT 1`).get(actor, key) as Row | undefined
    return row ? toRequest(row) : null
  }
  const openBySubject = (subject: string): HumanRequest | null => {
    const row = kernel.db.prepare(`SELECT * FROM human_requests WHERE subject=? AND status='open' ORDER BY id DESC LIMIT 1`).get(subject) as Row | undefined
    return row ? toRequest(row) : null
  }

  const resolve = (id: number, status: HumanStatus, by: string, note: string | null = null): HumanRequest | null => {
    const before = find(id)
    if (!before) return null
    const now = kernel.iso()
    const reopening = status === 'open'
    kernel.db.prepare('UPDATE human_requests SET status=?, resolution=?, resolved_at=?, resolved_by=?, updated_at=? WHERE id=?')
      .run(status, reopening ? null : note ?? before.resolution, reopening ? null : now, reopening ? null : by, now, id)
    kernel.changed(null)
    return find(id)!
  }
  const close = (subject: string, status: HumanStatus, by: string, note: string | null = null): HumanRequest | null => {
    const open = openBySubject(subject)
    return open ? resolve(open.id, status, by, note) : null
  }

  return {
    isStatus,
    count,
    find: (id) => find(id),
    list,
    inbox: (shown = 50) => ({ open: count(), items: list('open', shown) }),
    resolve,
    close,

    /** The ask about a board follows the board's name: a person renamed it while it waited for someone. */
    rename(from, to) {
      const before = `board:${from}`
      if (!kernel.db.prepare('SELECT id FROM human_requests WHERE subject=? LIMIT 1').get(before)) return
      kernel.db.prepare('UPDATE human_requests SET subject=? WHERE subject=?').run(`board:${to}`, before)
      kernel.changed(null)
    },

    /**
     * File a request. With a `subject`, an open request about that subject is updated in place (the ask changed) and
     * returned; with a `key`, one open request per actor and key is kept, as the API promises. Otherwise a new row.
     */
    file(ask) {
      const now = kernel.iso()
      const title = (oneLine(ask.title ?? '') || oneLine((ask.body ?? '').split('\n')[0] ?? '')).slice(0, 200)
      const body = ask.body === undefined ? '' : cleaned(ask.body)
      const kind = (ask.kind && oneLine(ask.kind) ? oneLine(ask.kind) : 'task').slice(0, 40)
      const context = ask.context === undefined || ask.context === null ? null : JSON.stringify(ask.context)
      const key = ask.key ? String(ask.key).trim().slice(0, 120) : null
      const subject = ask.subject ? String(ask.subject).trim().slice(0, 200) : null
      const source = ask.source ? String(ask.source).slice(0, 40) : 'ask'
      if (subject) {
        const open = openBySubject(subject)
        // The same ask again (a poller and a command line both report it) is not news: report it, change nothing.
        if (open && open.title === title && open.body === body) return open
        if (open) {
          kernel.db.prepare('UPDATE human_requests SET title=?, body=?, kind=?, context=?, updated_at=? WHERE id=?').run(title, body, kind, context, now, open.id)
          kernel.changed(null)
          return find(open.id)!
        }
      }
      if (key) { const existing = openByActorKey(ask.actor, key); if (existing) return existing }
      const result = kernel.db.prepare('INSERT INTO human_requests(at, updated_at, actor, kind, title, body, context, task_key, subject, source) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(now, now, ask.actor, kind, title, body, context, key, subject, source)
      kernel.changed(null)
      return find(Number(result.lastInsertRowid))!
    },
  }
}
