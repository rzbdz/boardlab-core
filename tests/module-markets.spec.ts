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

  it('names the commands a module brings, and says when its cli file is not there', () => {
    const dir = marketRepo('commands', [{ id: 'probe', manifest: { cli: 'probe/cli.js' } }, { id: 'other', manifest: { cli: 'other/cli.js' } }])
    writeFileSync(join(dir, 'probe/cli.js'), 'export const commands = { title: "探针", commands: [] }\n')
    const { modules, problems } = readMarket('commands', dir)
    expect(modules.find(module => module.id === 'probe')).toMatchObject({ cli: join(dir, 'probe/cli.js') })
    expect(modules.find(module => module.id === 'other')?.cli).toBeNull()
    expect(problems.join('\n')).toMatch(/other 的 cli other\/cli\.js 不在/)
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
    const { loaded: selected } = await marketModules(state, { probe: {} }, [], SDK)
    expect(selected).toHaveLength(1)
    const lab = new BoardLab({ db: openDatabase(join(state, 'boards.sqlite')), modules: selected.map(({ module }) => module), moduleMarkets: marketsOf(state) })
    expect(lab.api.list().some(item => item.path === '/api/probe')).toBe(true)
    expect(lab.state('user:a').plugins).toContainEqual(expect.objectContaining({ id: 'probe', status: 'active' }))
    await lab.loader.remove('probe')
    expect(lab.api.list().some(item => item.path === '/api/probe')).toBe(false)
  })

  it('takes a module exported by name, for a file that also exports what the module is made of', async () => {
    const source = marketRepo('named', [{ id: 'probe', source: `
      export function helper() { return 1 }
      export const module = { id: 'probe', title: 'probe', setup: () => ({ made: helper() }) }
    ` }])
    const state = join(root, 'state-named')
    const synced = await syncMarket(state, 'demo', { url: source })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'demo', url: synced.dir, commit: synced.commit }] }))
    const { loaded: selected } = await marketModules(state, { probe: {} }, [], SDK)
    expect((selected[0]!.module.setup({} as never, {} as never) as { made: number }).made).toBe(1)
  })

  it('takes a module made by a function the entry exports, as a module object may be exported', async () => {
    // A file that also exports what its module is built from offers the module as a factory: the module a market offers
    // is the one that factory makes with no arguments.
    // The export is named after the module (`some-module` -> `someModule`): a file that also exports helpers offers
    // exactly one thing as its module.
    const source = marketRepo('factory', [{ id: 'some-module', source: `
      export const helper = () => 1
      export function someModule() { return { id: 'some-module', title: 'some-module', setup: () => ({ made: helper() }) } }
    ` }])
    const state = join(root, 'state-factory')
    const synced = await syncMarket(state, 'demo', { url: source })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'demo', url: synced.dir, commit: synced.commit }] }))
    const { loaded: selected } = await marketModules(state, { 'some-module': {} }, [], SDK)
    expect(selected[0]!.module.id).toBe('some-module')
    expect(selected[0]!.module.setup({} as never, {} as never)).toEqual({ made: 1 })
  })

  it('refuses a module whose id is not the one the manifest offered, and one a market offers twice', async () => {    const wrong = join(root, 'wrong-src')
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

  it('leaves out a market module that cannot be imported and says so, rather than stopping boardd', async () => {
    // A foreign package is the machine owner's own choice: a broken one must not keep the rest of the lab down.
    const broken = marketRepo('broken', [{ id: 'broken', source: 'throw new Error("its dependency is not here")' }])
    const state = join(root, 'state-broken')
    const synced = await syncMarket(state, 'demo', { url: broken })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'demo', url: synced.dir, commit: synced.commit }] }))
    const result = await marketModules(state, { broken: {} }, [], SDK)
    expect(result.loaded).toEqual([])
    expect(result.failed).toEqual([{ id: 'broken', problem: expect.stringContaining('its dependency is not here') }])
  })

  it('tells a market module where boardd keeps its state, and nothing else', async () => {
    // `ctx.stateDir` is where a module writes what outlives a run (a vendor module's certificate); a lab built without it
    // must not hand a module the working directory of whatever process built it.
    const state = join(root, 'state-dir')
    const lab = new BoardLab({ db: openDatabase(join(state, 'boards.sqlite')), stateDir: state, modules: [{ id: 'probe', title: 'probe', setup: (_l, ctx) => ({ dir: ctx.stateDir }) }] })
    expect(lab.service<{ dir: string }>('probe').dir).toBe(state)
  })

  it('gives a market module the settings its configuration has for it', async () => {
    const source = marketRepo('settings', [{ id: 'probe', source: 'export default { id: "probe", title: "probe", setup(lab, ctx) { lab.api.addOne("probe", { method: "GET", path: "/api/probe", about: "p", handle: () => ({ settings: ctx.config }) }); return {} } }\n' }])
    const state = join(root, 'state-settings')
    const synced = await syncMarket(state, 'demo', { url: source })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'demo', url: synced.dir, commit: synced.commit }] }))
    const { loaded: selected } = await marketModules(state, { probe: { greeting: 'hi' } }, [], SDK)
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
    expect(await marketModules(state, {}, [], SDK)).toEqual({ loaded: [], failed: [] })
    expect((await marketModules(state, { other: {} }, [], SDK)).loaded.map(item => item.module.id)).toEqual(['other'])
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

describe('a market cannot reach past its own page part', () => {
  /** A manifest naming `ui`, written by hand: the checks are about paths, not about what the module does. */
  const withUi = (ui: string) => {
    const dir = join(root, `ui-${Math.random().toString(36).slice(2, 8)}-src`)
    mkdirSync(join(dir, 'probe'), { recursive: true })
    writeFileSync(join(dir, 'market.json'), JSON.stringify({ modules: [{ id: 'probe', title: 'p', entry: 'probe/module.js', ui }] }))
    writeFileSync(join(dir, 'probe/module.js'), 'export default { id: "probe", title: "p", setup: () => ({}) }')
    // The part itself, when the manifest names one under the module's own directory: it is committed with the market.
    if (ui.startsWith('probe/') && !ui.includes('..')) writeFileSync(join(dir, ui), 'export const ui = { views: () => [] }')
    git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'market')
    return dir
  }

  it('refuses a ui that is the clone\'s .git, a file outside it, or a symlink pointing out', async () => {
    const state = join(root, 'state-ui')
    const out = join(root, 'outside.json'); writeFileSync(out, 'secret')
    const gitConfig = await syncMarket(state, 'gitprobe', { url: marketRepo('gitprobe', [{ id: 'probe', manifest: { ui: '.git/config' } }]) })
    expect(readMarket('gitprobe', gitConfig.dir).problems.join('\n')).toMatch(/\.git/)
    const outside = withUi('../../outside.json')
    expect(readMarket('sym', outside).problems.join('\n')).toMatch(/不能从市场里提供|不在/)
    const linked = withUi('probe/leak.js')
    mkdirSync(join(linked, 'probe'), { recursive: true })
    try { execFileSync('ln', ['-s', out, join(linked, 'probe/leak.js')]) } catch { return }
    expect(readMarket('link', linked).problems.join('\n')).toMatch(/不能从市场里提供/)
  })

  it('serves a loaded module\'s page part, and not other files of its directory', async () => {
    const { serve } = await import('../src/server/http.ts')
    const state = join(root, 'state-serve')
    const dir = withUi('probe/ui.js')
    writeFileSync(join(dir, 'probe/secret.txt'), 'no')
    const synced = await syncMarket(state, 'serve', { url: dir })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'serve', url: synced.dir, commit: synced.commit }] }))
    const markets = marketsOf(state)
    const lab = new BoardLab({ db: openDatabase(join(state, 'boards.sqlite')), moduleMarkets: markets,
      modules: [{ id: 'probe', title: 'p', setup: (_l, ctx) => { ctx.effect(() => () => {}); return {} } }] })
    const ui = join(state, 'ui'); mkdirSync(ui, { recursive: true }); writeFileSync(join(ui, 'index.html'), '<html></html>')
    const running = await serve(lab, { port: 0, socketPath: join(state, 'b.sock'), uiDir: ui })
    try {
      const port = (running.http[0]!.address() as { port: number }).port
      const ask = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`)).status
      const first = await ask('/module-ui/probe/ui.js'); expect([first, await ask('/module-ui/probe/secret.txt'), await ask('/api/state')]).toEqual([200, 404, 200])
      // `constructor` is Object's own property on a plain map: it must be a 404, never a throw that ends the process.
      expect(await ask('/module-ui/constructor/x')).toBe(404)
      expect(await ask('/module-ui/probe/secret.txt')).toBe(404)
      expect(await ask('/module-ui/probe/..%2Fmarket.json')).toBe(404)
      // boardd is still answering after all of that.
      expect(await ask('/api/state')).toBe(200)
    } finally { await running.close() }
  })

  it('does not offer a page part of a module that is not loaded', async () => {
    const state = join(root, 'state-unloaded')
    const dir = withUi('probe/ui.js')
    const synced = await syncMarket(state, 'unloaded', { url: dir })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'unloaded', url: synced.dir, commit: synced.commit }] }))
    const lab = new BoardLab({ db: openDatabase(join(state, 'boards.sqlite')), moduleMarkets: marketsOf(state) })
    const found = lab.api.match('GET', '/api/module-markets')!
    const answered = found.endpoint.handle({ params: found.params, query: new URLSearchParams(), caller: { holder: 'user:a' } as never, signal: new AbortController().signal } as never) as { pages: unknown[] }
    expect(answered.pages).toEqual([])
  })
})

describe('a market brings its help pages', () => {
  /** A market whose module keeps its help beside its entry (`probe/docs/`), or in a directory the manifest names. */
  function withDocs(name: string, manifest: Record<string, unknown> = {}, pages: Record<string, string> = { 'usage.md': '# Using it\n\nWhat it does.\n' }) {
    const dir = marketRepo(name, [{ id: 'probe', manifest }])
    mkdirSync(join(dir, 'probe/docs'), { recursive: true })
    for (const [name, body] of Object.entries(pages)) writeFileSync(join(dir, 'probe/docs', name), body)
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'docs')
    return dir
  }

  it('reads the pages beside a module\'s entry, titled by their heading and named <module>/<page>', () => {
    const dir = withDocs('docs')
    const { modules, problems } = readMarket('docs', dir)
    expect(problems).toEqual([])
    expect(modules[0]!.docs).toEqual([{ name: 'probe/usage', title: 'Using it', file: join(dir, 'probe/docs/usage.md') }])
  })

  it('takes a directory when the manifest names one, and is silent for a module with no help', () => {
    const dir = marketRepo('no-docs', [{ id: 'probe' }])
    expect(readMarket('no-docs', dir).modules[0]!.docs).toEqual([])
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'pages/intro.md'), 'no heading\n')
    writeFileSync(join(dir, 'pages/notes.txt'), 'not a page')
    writeFileSync(join(dir, 'market.json'), JSON.stringify({ modules: [{ id: 'probe', entry: 'probe/module.js', docs: 'pages' }] }))
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'pages')
    expect(readMarket('no-docs', dir).modules[0]!.docs).toEqual([{ name: 'probe/intro', title: 'intro', file: join(dir, 'pages/intro.md') }])
  })

  it('will not serve a page that leaves the market, and says so', () => {
    const dir = withDocs('docs-symlink')
    const outside = join(root, 'outside.md'); writeFileSync(outside, 'secret')
    try { execFileSync('rm', [join(dir, 'probe/docs/usage.md')]); execFileSync('ln', ['-s', outside, join(dir, 'probe/docs/usage.md')]) } catch { return }
    expect(readMarket('docs-link', dir).problems.join('\n')).toMatch(/帮助页 usage\.md 不能从市场里提供/)
  })

  it('answers GET /api/docs/<module>/<page> beside boardd\'s own, and lists them together', async () => {
    const { serve } = await import('../src/server/http.ts')
    const state = join(root, 'state-docs')
    const dir = withDocs('docs-served')
    const synced = await syncMarket(state, 'docs', { url: dir })
    writeFileSync(marketsFile(state), JSON.stringify({ markets: [{ id: 'docs', url: synced.dir, commit: synced.commit }] }))
    const own = join(state, 'help'); mkdirSync(own, { recursive: true }); writeFileSync(join(own, 'site.md'), '# The site\n')
    const ui = join(state, 'ui2'); mkdirSync(ui, { recursive: true }); writeFileSync(join(ui, 'index.html'), '<html></html>')
    const lab = new BoardLab({ db: openDatabase(join(state, 'boards.sqlite')), moduleMarkets: marketsOf(state) })
    const marketDocs = readMarket('docs', synced.dir).modules.flatMap(module => module.docs)
    const running = await serve(lab, { port: 0, socketPath: join(state, 'b.sock'), uiDir: ui, docsDir: own, marketDocs: () => marketDocs })
    try {
      const base = `http://127.0.0.1:${(running.http[0]!.address() as { port: number }).port}`
      expect(await (await fetch(`${base}/api/docs`)).json()).toEqual({ docs: [{ name: 'site', title: 'The site' }, { name: 'probe/usage', title: 'Using it' }] })
      expect(await (await fetch(`${base}/api/docs/probe%2Fusage`)).json()).toEqual({ name: 'probe/usage', title: 'Using it', text: '# Using it\n\nWhat it does.\n' })
      expect((await fetch(`${base}/api/docs/probe%2Fmissing`)).status).toBe(404)
    } finally { await running.close() }
  })
})
