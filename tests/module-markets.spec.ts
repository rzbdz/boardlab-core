/**
 * Module markets: a git repository of module packages that a boardd imports by file URL, with a manifest it never runs.
 * The tests use a local repository (a real `git init`) and a module that adds one endpoint, so the chain a site depends
 * on — manifest → clone → select → import → lab — is the one exercised.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase } from '../src/core/db.ts'
import { BoardLab } from '../src/core/lab.ts'
import type { Module } from '../src/core/module.ts'
import { digestOf, readMarket, readRecords, marketsFile } from '../src/core/module-markets.ts'
import { importMarketModule, marketModules, marketsOf, syncMarket } from '../src/server/markets.ts'

const root = mkdtempSync(join(tmpdir(), 'boardlab-markets-'))
/** The surface a market module imports as `boardlab`, built from this core (not built in a test: the SDK is the core's). */
/** A plain ES module exporting the same values as `core/sdk.ts`: what the child in the import test points `boardlab` at. */
const SDK = join(root, 'sdk.mjs')
writeFileSync(SDK, [
  "export class BoardError extends Error { constructor(code, message) { super(message); this.code = code } }",
  'export class BusyError extends BoardError { constructor(message) { super("conflict", message) } }',
  'export class TextReply { constructor(body, type = "application/json") { this.body = body; this.type = type } }',
  'export const SDK = 1',
].join('\n'))
afterAll(() => { /* the temp tree is left for the OS to reap: nothing here is shared */ })

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', ...args], { cwd, encoding: 'utf8' }).trim()

/** A market repository with one module: `probe`, which adds an endpoint saying what its settings were. */
function marketRepo(name: string, modules: Array<{ id: string, manifest?: Record<string, unknown>, source?: string }>) {
  const dir = join(root, `${name}-src`)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'market.json'), JSON.stringify({ modules: modules.map(({ id, manifest }) => ({ id, title: id, ...manifest })) }))
  for (const { id, source } of modules) {
    mkdirSync(join(dir, id), { recursive: true })
    writeFileSync(join(dir, id, 'module.js'), source ?? `
      export default {
        id: ${JSON.stringify(id)}, title: ${JSON.stringify(id)},
        setup(lab, ctx) { lab.api.addOne(${JSON.stringify(id)}, { method: 'GET', path: '/api/${id}', about: ${JSON.stringify(id)}, handle: () => ({ from: ${JSON.stringify(id)} }) }); return {} },
      }
    `)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'market')
  return dir
}

describe('a market manifest', () => {
  it('says what it offers without running any of it, and hashes each entry so an update is visible', () => {
    const dir = marketRepo('manifest', [{ id: 'probe', manifest: { about: '一个探针', tags: ['test'], inject: ['base'], provide: ['probe-api'] } }])
    const { modules, problems } = readMarket('manifest', dir)
    expect(problems).toEqual([])
    expect(modules).toHaveLength(1)
    expect(modules[0]).toMatchObject({ id: 'probe', title: 'probe', about: '一个探针', tags: ['test'], inject: ['base'], provide: ['probe-api'], market: 'manifest' })
    expect(modules[0]!.digest).toBe(digestOf(join(dir, 'probe/module.js')))
  })

  it('names what is wrong instead of importing something that is not there', () => {
    const dir = join(root, 'broken-src')
    mkdirSync(join(dir, 'gone'), { recursive: true })
    writeFileSync(join(dir, 'market.json'), JSON.stringify({ modules: [{ id: 'gone', entry: 'gone/none.js' }, { id: 'far', entry: '../../outside.js' }, { id: 'not an id' }, { id: 'gone' }] }))
    const { modules, problems } = readMarket('broken', dir)
    expect(modules).toEqual([])
    expect(problems.join('\n')).toMatch(/gone\/none\.js 不在/)
    expect(problems.join('\n')).toMatch(/不在市场目录里/)
    expect(problems.join('\n')).toMatch(/合法的 id/)
    expect(problems.join('\n')).toMatch(/写了两次/)
  })

  it('finds an entry under the module id when the manifest names none', () => {
    const dir = marketRepo('default-entry', [{ id: 'probe' }])
    expect(readMarket('default-entry', dir).problems).toEqual([])
  })
})

describe('a market on this machine', () => {
  it('is cloned, recorded, and read again as the market it is', async () => {
    const source = marketRepo('cloned', [{ id: 'probe' }])
    const state = join(root, 'state-cloned')
    const first = await syncMarket(state, 'demo', { url: source })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'demo', url: source, branch: null, commit: first.commit }] }))
    const { records, problems } = readRecords(state)
    expect(problems).toEqual([])
    expect(records).toHaveLength(1)
    expect(marketsOf(state)[0]).toMatchObject({ id: 'demo', url: source, commit: first.commit })
    expect(marketsOf(state)[0]!.modules.map(module => module.id)).toEqual(['probe'])
  })

  it('follows the source on update, and a changed entry changes its digest', async () => {
    const source = marketRepo('updated', [{ id: 'probe' }])
    const state = join(root, 'state-updated')
    const first = await syncMarket(state, 'demo', { url: source })
    const before = readMarket('demo', first.dir).modules[0]!.digest
    writeFileSync(join(source, 'probe/module.js'), 'export default { id: "probe", title: "probe", setup: () => ({}) }\n')
    git(source, 'add', '-A'); git(source, 'commit', '-q', '-m', 'change')
    const second = await syncMarket(state, 'demo', { url: source })
    expect(second.commit).not.toBe(first.commit)
    expect(readMarket('demo', second.dir).modules[0]!.digest).not.toBe(before)
  })
})

describe('a module from a market', () => {
  it('runs in the lab like any module, and is taken down like any module', async () => {
    const source = marketRepo('running', [{ id: 'probe' }])
    const state = join(root, 'state-running')
    const synced = await syncMarket(state, 'demo', { url: source })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'demo', url: source, branch: null, commit: synced.commit }] }))
    const selected = await marketModules(state, { probe: {} }, [], SDK)
    expect(selected).toHaveLength(1)
    const lab = new BoardLab({ db: openDatabase(join(state, 'boards.sqlite')), modules: selected.map(({ module }) => module), moduleMarkets: marketsOf(state) })
    expect(lab.api.list().some(item => item.path === '/api/probe')).toBe(true)
    expect(lab.state('user:a').plugins).toContainEqual(expect.objectContaining({ id: 'probe', status: 'active' }))
    await lab.loader.remove('probe')
    expect(lab.api.list().some(item => item.path === '/api/probe')).toBe(false)
  })

  it('refuses a module whose id is not the one the manifest offered, and one a market offers twice', async () => {
    const wrong = join(root, 'wrong-src')
    mkdirSync(join(wrong, 'asked'), { recursive: true })
    writeFileSync(join(wrong, 'market.json'), JSON.stringify({ modules: [{ id: 'asked' }] }))
    writeFileSync(join(wrong, 'asked/module.js'), 'export default { id: "other", title: "other", setup: () => ({}) }\n')
    await expect(importMarketModule(readMarket('wrong', wrong).modules[0]!)).rejects.toThrow(/说自己是 other/)

    const state = join(root, 'state-twice')
    const one = await syncMarket(state, 'one', { url: marketRepo('one', [{ id: 'probe' }]) })
    const two = await syncMarket(state, 'two', { url: marketRepo('two', [{ id: 'probe' }]) })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'one', url: one.dir, commit: one.commit }, { id: 'two', url: two.dir, commit: two.commit }] }))
    await expect(marketModules(state, { probe: {} }, [], SDK)).rejects.toThrow(/几个市场都提供/)
    await expect(marketModules(state, { probe: {} }, ['probe'], SDK)).rejects.toThrow(/随 boardlab 提供/)
  })

  it('gives a market module the settings its configuration has for it', async () => {
    const source = marketRepo('settings', [{ id: 'probe', source: 'export default { id: "probe", title: "probe", setup(lab, ctx) { lab.api.addOne("probe", { method: "GET", path: "/api/probe", about: "p", handle: () => ({ settings: ctx.config }) }); return {} } }\n' }])
    const state = join(root, 'state-settings')
    const synced = await syncMarket(state, 'demo', { url: source })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'demo', url: synced.dir, commit: synced.commit }] }))
    const selected = await marketModules(state, { probe: { greeting: 'hi' } }, [], SDK)
    const lab = new BoardLab({ db: openDatabase(join(state, 'boards.sqlite')), modules: selected.map(({ module }) => module), settings: Object.fromEntries(selected.map(({ module, settings }) => [module.id, settings])) })
    const found = lab.api.match('GET', '/api/probe')!
    expect(found.endpoint.handle({ params: found.params, query: new URLSearchParams(), signal: new AbortController().signal } as never)).toEqual({ settings: { greeting: 'hi' } })
  })

  it('reaches boardlab by importing it by name, resolved to the surface this boardd runs', async () => {
    // What a module outside boardlab's build does: no node_modules, no relative path into the distribution. The resolver
    // hook is node's own, so this runs in a child node rather than in place: vitest resolves modules its own way.
    const source = marketRepo('boardlab-import', [{
      id: 'probe',
      source: `
        import { BoardError, TextReply, SDK } from 'boardlab'
        const caught = (() => { try { throw new BoardError('invalid', 'nope') } catch (error) { return error instanceof BoardError && error.code === 'invalid' } })()
        export default { id: 'probe', title: 'probe', setup: () => ({ caught, sdk: SDK, text: new TextReply('ok', 'text/plain').body }) }
      `,
    }])
    const state = join(root, 'state-boardlab-import')
    const synced = await syncMarket(state, 'demo', { url: source })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'demo', url: source, commit: synced.commit }] }))
    const script = join(root, 'import-check.mjs')
    // The hook this process installs (src/server/sdk.ts), in plain JS: this child runs from source, and only a built
    // boardlab has a dist/sdk.js for the hook to point at.
    writeFileSync(script, [
      "import { registerHooks } from 'node:module'",
      "import { pathToFileURL } from 'node:url'",
      'let sdk = null',
      "registerHooks({ resolve(specifier, context, next) { return specifier === 'boardlab' && sdk ? { url: sdk, shortCircuit: true, format: 'module' } : next(specifier, context) } })",
      'sdk = pathToFileURL(process.env.SDK).href',
      'const loaded = await import(pathToFileURL(process.env.ENTRY).href)',
      'console.log(JSON.stringify(loaded.default.setup()))',
    ].join('\n'))
    const out = execFileSync(process.execPath, ['--no-warnings', script], { env: { ...process.env, SDK, ENTRY: join(synced.dir, 'probe/module.js') }, encoding: 'utf8' })
    expect(JSON.parse(out.trim().split('\n').at(-1)!)).toEqual({ caught: true, sdk: 1, text: 'ok' })
  })

  it('imports only what the configuration selects', async () => {
    const state = join(root, 'state-selected')
    const synced = await syncMarket(state, 'demo', { url: marketRepo('selected', [{ id: 'probe' }, { id: 'other' }]) })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'demo', url: synced.dir, commit: synced.commit }] }))
    expect(await marketModules(state, {}, [], SDK)).toEqual([])
    expect((await marketModules(state, { other: {} }, [], SDK)).map(item => item.module.id)).toEqual(['other'])
  })
})

describe('the markets in the state', () => {
  it('is asked for by anyone: the state says which markets there are and what each offers', async () => {
    const state = join(root, 'state-visible')
    const synced = await syncMarket(state, 'demo', { url: marketRepo('visible', [{ id: 'probe' }]) })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'demo', url: synced.dir, commit: synced.commit }] }))
    const lab = new BoardLab({ db: openDatabase(join(state, 'boards.sqlite')), moduleMarkets: marketsOf(state) })
    const call = (path: string) => {
      const found = lab.api.match('GET', path)!
      return found.endpoint.handle({ params: found.params, query: new URLSearchParams(), caller: { holder: 'user:a' } as never, signal: new AbortController().signal } as never)
    }
    expect(call('/api/module-markets')).toMatchObject({ markets: [{ id: 'demo', modules: [{ id: 'probe' }] }], problems: [] })
    expect(call('/api/module-markets/demo')).toMatchObject({ market: { id: 'demo' }, modules: [{ offered: { id: 'probe' }, loaded: null }] })
    expect(call('/api/module-markets/none')).toEqual({ market: null })
  })

  it('says what went wrong with markets.json itself without stopping boardd', () => {
    const state = join(root, 'state-broken')
    mkdirSync(state, { recursive: true })
    writeFileSync(marketsFile(state), '{ not json')
    const { records, problems } = readRecords(state)
    expect(records).toEqual([])
    expect(problems.join('\n')).toMatch(/markets\.json 读不了/)
    expect(existsSync(marketsFile(state))).toBe(true)
    expect(readFileSync(marketsFile(state), 'utf8')).toBe('{ not json')
  })
})
