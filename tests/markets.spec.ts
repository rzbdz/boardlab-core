/** Image markets against a fake driver: setup, sorting newest first, the SoC filter, the minute's cache. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/core/db.ts'
import { BoardLab } from '../src/core/lab.ts'
import { sortEntries, type ImageMarket } from '../src/core/markets.ts'
import type { Board, MarketEntry } from '../src/shared/types.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boardlab-markets-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const folder = (path: string, soc: string | null = null): MarketEntry => ({ path, name: path.split('/').at(-1)!, kind: 'folder', soc })
const image = (path: string, modified: string, soc: string | null = null): MarketEntry => ({ path, name: path.split('/').at(-1)!, kind: 'image', soc, modified })

/** A market over a fixed tree that counts how often it is asked. */
function shelf(tree: Record<string, MarketEntry[]>, asked: string[]): ImageMarket {
  return {
    list: async path => { asked.push(path); if (!(path in tree)) throw new Error(`no folder ${path}`); return tree[path]! },
    locate: async path => ({ url: `https://images.example.org/${path}`, name: path.split('/').at(-1)! }),
  }
}

function lab(now: { t: number }) {
  return new BoardLab({ db: openDatabase(join(dir, 'state.sqlite')), now: () => now.t })
}

describe('image markets', () => {
  it('lists a folder newest first, filtered to a SoC, and reads it again only after a minute or on refresh', async () => {
    const now = { t: Date.parse('2026-01-01T00:00:00Z') }
    const asked: string[] = []
    const boards = lab(now)
    boards.markets.offer({ kind: 'shelf', title: '书架', about: 'a fixed tree', create: config => shelf(config.tree as Record<string, MarketEntry[]>, asked) })
    boards.markets.configure('main', {
      kind: 'shelf', title: 'Main images', source: 'test', config: {
        tree: {
          '': [folder('alpha', 'alpha'), folder('beta', 'beta'), folder('shared')],
          'alpha': [image('alpha/old.zip', '2026-01-01T00:00:00Z'), folder('alpha/v1.9'), image('alpha/new.zip', '2026-03-01T00:00:00Z'), folder('alpha/v1.10'), folder('alpha/20260102'), folder('alpha/20260110')],
        },
      },
    })
    expect(boards.state('user:test').markets).toEqual([{ id: 'main', kind: 'shelf', kindTitle: '书架', about: 'a fixed tree', title: 'Main images', source: 'test', error: null }])

    const top = await boards.markets.folder('main', '/', { soc: 'ALPHA' })
    expect(top.entries.map(e => e.name)).toEqual(['shared', 'alpha'])
    const inside = await boards.markets.folder('main', 'alpha/')
    expect(inside.entries.map(e => e.name)).toEqual(['v1.10', 'v1.9', '20260110', '20260102', 'new.zip', 'old.zip'])

    await Promise.all([boards.markets.folder('main', 'alpha'), boards.markets.folder('main', 'alpha', { refresh: true }), boards.markets.folder('main', 'alpha', { refresh: true })])
    // Two asks for a folder being read wait for the same read.
    expect(asked).toEqual(['', 'alpha', 'alpha'])
    now.t += 61_000
    await boards.markets.folder('main', 'alpha')
    await boards.markets.folder('main', 'alpha', { refresh: true })
    expect(asked).toEqual(['', 'alpha', 'alpha', 'alpha', 'alpha'])

    expect(await boards.markets.locate('main', 'alpha/new.zip')).toEqual({ url: 'https://images.example.org/alpha/new.zip', name: 'new.zip' })
    await expect(boards.markets.folder('main', '../etc')).rejects.toMatchObject({ code: 'invalid' })
    await expect(boards.markets.folder('main', 'nowhere')).rejects.toMatchObject({ code: 'hardware', message: expect.stringContaining('no folder nowhere') })
    await expect(boards.markets.folder('other', '')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('keeps a market whose driver is missing or refuses its configuration, saying why, and makes it once the driver comes', async () => {
    const boards = lab({ t: 0 })
    boards.markets.configure('later', { kind: 'shelf', config: { tree: { '': [] } }, source: 'site' })
    expect(boards.markets.list()[0]).toMatchObject({ id: 'later', title: 'later', error: expect.stringContaining('没有 shelf') })
    await expect(boards.markets.folder('later', '')).rejects.toMatchObject({ code: 'invalid' })
    boards.markets.offer({ kind: 'shelf', title: '书架', about: '', create: config => { if (!config.tree) throw new Error('tree 要写'); return shelf(config.tree as Record<string, MarketEntry[]>, []) } })
    expect(boards.markets.list()[0]!.error).toBeNull()
    boards.markets.configure('broken', { kind: 'shelf', config: {}, source: 'site' })
    expect(boards.markets.list().find(m => m.id === 'broken')!.error).toContain('tree 要写')

    // A market its source could not read is listed with what the source found.
    boards.markets.configure('unread', { kind: '', config: {}, source: 'site', problem: 'markets/unread.yaml：YAML 写错了' })
    expect(boards.markets.list().find(m => m.id === 'unread')!.error).toBe('markets/unread.yaml：YAML 写错了')
    await expect(boards.markets.folder('unread', '')).rejects.toThrow(/用不了：markets\/unread.yaml/)
    // A source re-reading its configuration takes down what it no longer has.
    boards.markets.configure('mine', { kind: 'shelf', config: { tree: {} }, source: 'module' })
    boards.markets.retain('site', ['later'])
    expect(boards.markets.list().map(m => m.id)).toEqual(['later', 'mine'])
  })

  it('sorts a release after its pre-releases and its patches after it, as a version history reads', () => {
    const names = ['v4.0rc4', 'v4.0.8', 'v4.0beta3', 'v4.0', 'v4.0.10', 'v4.0rc10', 'v4.0alpha1', 'v4.1rc1', 'v3.9', 'debian', 'alpine']
    expect(sortEntries(names.map(name => folder(name))).map(e => e.name)).toEqual(['v4.1rc1', 'v4.0.10', 'v4.0.8', 'v4.0', 'v4.0rc10', 'v4.0rc4', 'v4.0beta3', 'v4.0alpha1', 'v3.9', 'debian', 'alpine'])
    expect(sortEntries(['1.2-beta.3', '1.2', '1.2-rc.1', '1.10'].map(name => folder(name))).map(e => e.name)).toEqual(['1.10', '1.2', '1.2-rc.1', '1.2-beta.3'])
    expect(sortEntries(['20261122', '20261123', '20261031'].map(name => folder(name))).map(e => e.name)).toEqual(['20261123', '20261122', '20261031'])
  })

  it('keeps the order a market gives the places it was set up with', () => {
    const placed = (name: string, order: number) => ({ ...folder(name), order })
    expect(sortEntries([placed('zeta', 0), folder('v2'), placed('alpha', 1), image('x.zip', '2026-01-01T00:00:00Z'), folder('v10')]).map(e => e.name)).toEqual(['zeta', 'alpha', 'v10', 'v2', 'x.zip'])
  })

  it('sorts dated and versioned names newest first and images by when they changed', () => {
    const sorted = sortEntries([image('b.zip', '2026-01-02T00:00:00Z'), folder('v4.0.9'), image('a.zip', '2026-02-01T00:00:00Z'), folder('v4.0.10'), image('c.zip', '')])
    expect(sorted.map(e => e.name)).toEqual(['v4.0.10', 'v4.0.9', 'a.zip', 'b.zip', 'c.zip'])
  })
})

describe('searching a market', () => {
  it('reads the whole tree and keeps only matching images and the folders leading to them, in their place', async () => {
    const asked: string[] = []
    const boards = lab({ t: 0 })
    boards.markets.offer({ kind: 'shelf', title: '书架', about: '', create: config => shelf(config.tree as Record<string, MarketEntry[]>, asked) })
    boards.markets.configure('main', {
      kind: 'shelf', config: {
        tree: {
          '': [folder('k3'), folder('k1'), folder('docs'), image('readme.zip', '2026-01-01T00:00:00Z')],
          'k3': [folder('k3/version', 'k3'), folder('k3/temp', 'k3'), image('k3/notes.zip', '2026-01-01T00:00:00Z', 'k3')],
          'k3/version': [folder('k3/version/v4.0', 'k3'), image('k3/version/kernel-only.img', '2026-01-01T00:00:00Z', 'k3')],
          'k3/version/v4.0': [image('k3/version/v4.0/bianbu-k3.zip', '2026-01-02T00:00:00Z', 'k3')],
          'k3/temp': [image('k3/temp/scratch.zip', '2026-01-01T00:00:00Z', 'k3')],
          'k1': [image('k1/bianbu-k1.zip', '2026-01-01T00:00:00Z', 'k1')],
          'docs': [folder('docs/deep')],
          'docs/deep': [image('docs/deep/kernel-notes.zip', '2026-01-01T00:00:00Z')],
        },
      }, source: 'test',
    })
    const found = await boards.markets.search('main', ' BIANBU ')
    // Both bianbu images, the folders between them and the top; nothing else — no scratch.zip, no doc folder with no match.
    expect(found.entries.map(e => e.path)).toEqual(['k3', 'k3/version', 'k3/version/v4.0', 'k3/version/v4.0/bianbu-k3.zip', 'k1', 'k1/bianbu-k1.zip'])
    expect(found).toMatchObject({ market: 'main', text: 'bianbu', folders: 8, partial: false })
    // Search is not a folder listing: a folder does not match by its name.
    expect((await boards.markets.search('main', 'version')).entries.map(e => e.path)).toEqual([])
    // A SoC keeps only its images.
    expect((await boards.markets.search('main', 'bianbu', { soc: 'k1' })).entries.filter(e => e.kind === 'image').map(e => e.path)).toEqual(['k1/bianbu-k1.zip'])
    // A folder gone since it was listed does not stop the search: the rest is found, and it says it was not whole.
    boards.markets.configure('gone', { kind: 'shelf', config: { tree: { '': [folder('x'), folder('y')], 'y': [image('y/hit.zip', '2026-01-01T00:00:00Z')] } }, source: 'test' })
    expect(await boards.markets.search('gone', 'hit')).toMatchObject({ partial: true, entries: [{ path: 'y' }, { path: 'y/hit.zip' }] })
    await expect(boards.markets.search('main', '  ')).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('searching a market, read side by side', () => {
  it('reads the folders below a level together, answers in tree order, and keeps the answer a minute', async () => {
    const asked: string[] = []
    let live = 0, most = 0
    const clock = { t: 0 }
    const boards = lab(clock)
    const now_add = (ms: number) => { clock.t += ms }
    const tree: Record<string, MarketEntry[]> = {
      '': Array.from({ length: 12 }, (_, i) => folder(`f${i}`)),
      ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, i === 7 ? [image('f7/found.zip', '2026-01-01T00:00:00Z')] : [folder(`f${i}/sub`)]]))
      , ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}/sub`, []]))
    }
    boards.markets.offer({ kind: 'shelf', title: '书架', about: '', create: () => ({
      list: async (at: string) => { asked.push(at); live++; most = Math.max(most, live); await new Promise(r => setTimeout(r, 15)); live--; return tree[at] ?? [] },
      locate: async () => ({ url: 'https://x/y', name: 'y' }),
    }) })
    boards.markets.configure('main', { kind: 'shelf', config: {}, source: 'test' })
    const found = await boards.markets.search('main', 'FOUND')
    expect(found.entries.map(e => e.path)).toEqual(['f7', 'f7/found.zip'])
    expect(found).toMatchObject({ folders: 24, partial: false })
    // The twelve folders were read together, not one after another.
    expect(most).toBeGreaterThan(1)
    // The same words again: the answer kept a minute, nothing asked again.
    const before = asked.length
    expect(await boards.markets.search('main', 'found')).toEqual(found)
    expect(asked.length).toBe(before)
    // Other words are their own search (the folders it read a moment ago are the minute's cache, so they are not
    // asked for again); once that cache runs out, a search reads the market again.
    expect(await boards.markets.search('main', 'nothing')).toMatchObject({ text: 'nothing', entries: [] })
    now_add(61_000)
    await boards.markets.search('main', 'nothing')
    expect(asked.length).toBeGreaterThan(before)
  })
})

describe('image markets for a board', () => {
  it('marks the images a board cannot take, by the market scheme and each name ending', async () => {
    const boards = lab({ t: 0 })
    boards.markets.offer({ kind: 'shelf', title: '书架', about: '', create: () => ({ ...shelf({ '': [image('a.zip', '2026-01-01T00:00:00Z'), image('b.iso', '2026-01-02T00:00:00Z'), folder('dir')] }, []), scheme: 'copy' }) })
    boards.markets.configure('main', { kind: 'shelf', config: {}, source: 'test' })
    const board = (packages: { schemes: string[], suffixes: string[] } | null) => ({ name: 'b1', lab: { packages } }) as unknown as Board
    const refused = async (packages: { schemes: string[], suffixes: string[] } | null) =>
      Object.fromEntries((await boards.markets.folder('main', '', { board: board(packages) })).entries.map(entry => [entry.name, entry.refused]))
    expect(await refused({ schemes: ['copy'], suffixes: ['.zip'] })).toEqual({ dir: undefined, 'b.iso': expect.stringContaining('刷不了这种包'), 'a.zip': null })
    expect(await refused({ schemes: ['https'], suffixes: [] })).toEqual({ dir: undefined, 'b.iso': expect.stringContaining('收 https 链接'), 'a.zip': expect.any(String) })
    expect((await refused(null))['a.zip']).toContain('不能用刷机包刷机')
    // Without a board, nothing is marked.
    expect((await boards.markets.folder('main', '')).entries.every(entry => !('refused' in entry))).toBe(true)
  })
})

describe('image markets over HTTP', () => {
  it('lists the markets and a folder through the gateway, as the CLI and the page ask', async () => {
    const { serve } = await import('../src/server/http.ts')
    const { BoardsClient } = await import('../src/shared/client.ts')
    const boards = lab({ t: Date.parse('2026-01-01T00:00:00Z') })
    boards.markets.offer({ kind: 'shelf', title: '书架', about: '', create: config => shelf((config.tree as Record<string, MarketEntry[]>) ?? { '': [folder('beta', 'beta'), folder('alpha', 'alpha')] }, []) })
    boards.markets.configure('main', { kind: 'shelf', config: {}, source: 'test' })
    const running = await serve(boards, { port: 0, socketPath: join(dir, 'boardd.sock'), uiDir: null })
    try {
      const client = new BoardsClient(join(dir, 'boardd.sock'))
      expect((await client.markets()).map(m => m.id)).toEqual(['main'])
      expect((await client.marketFolder('main')).entries.map(e => e.name)).toEqual(['beta', 'alpha'])
      expect((await client.marketFolder('main', '', { soc: 'alpha' })).entries.map(e => e.name)).toEqual(['alpha'])
      // A search over the gateway: a folder is only listed when an image below it matches.
      boards.markets.configure('deep', { kind: 'shelf', config: { tree: { '': [folder('pics')], 'pics': [image('pics/alpha-five.zip', '2026-01-01T00:00:00Z'), image('pics/beta.zip', '2026-01-01T00:00:00Z')] } }, source: 'test' })
      expect((await client.marketSearch('deep', ' ALP ')).entries.map(e => e.path)).toEqual(['pics', 'pics/alpha-five.zip'])
      expect((await client.marketSearch('deep', 'nothing-at-all')).entries).toEqual([])
      await expect(client.marketFolder('none')).rejects.toMatchObject({ status: 404 })
    } finally { await running.close() }
  })
})
