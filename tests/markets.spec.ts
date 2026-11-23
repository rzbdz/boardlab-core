/** Image markets against a fake driver: setup, sorting newest first, the SoC filter, the minute's cache. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/core/db.ts'
import { BoardLab } from '../src/core/lab.ts'
import { sortEntries, type ImageMarket } from '../src/core/markets.ts'
import type { MarketEntry } from '../src/shared/types.ts'

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

describe('image markets over HTTP', () => {
  it('lists the markets and a folder through the gateway, as the CLI and the page ask', async () => {
    const { serve } = await import('../src/server/http.ts')
    const { BoardsClient } = await import('../src/shared/client.ts')
    const boards = lab({ t: Date.parse('2026-01-01T00:00:00Z') })
    boards.markets.offer({ kind: 'shelf', title: '书架', about: '', create: () => shelf({ '': [folder('beta', 'beta'), folder('alpha', 'alpha')] }, []) })
    boards.markets.configure('main', { kind: 'shelf', config: {}, source: 'test' })
    const running = await serve(boards, { port: 0, socketPath: join(dir, 'boardd.sock'), uiDir: null })
    try {
      const client = new BoardsClient(join(dir, 'boardd.sock'))
      expect((await client.markets()).map(m => m.id)).toEqual(['main'])
      expect((await client.marketFolder('main')).entries.map(e => e.name)).toEqual(['beta', 'alpha'])
      expect((await client.marketFolder('main', '', { soc: 'alpha' })).entries.map(e => e.name)).toEqual(['alpha'])
      await expect(client.marketFolder('none')).rejects.toMatchObject({ status: 404 })
    } finally { await running.close() }
  })
})
