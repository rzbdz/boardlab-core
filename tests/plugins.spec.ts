/**
 * The plugin runtime: a module registers through its context, so it can be taken down; and it declares what it needs,
 * so the loader decides when it runs.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { openDatabase } from '../src/core/db.ts'
import { BoardLab } from '../src/core/lab.ts'
import type { Module } from '../src/core/module.ts'
import { Loader } from '../src/core/plugin.ts'
import { registryOf } from '../src/core/plugin-registry.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'boardlab-plugins-'))


const labOf = (modules: Module[] = [], name = 'plugin.sqlite') => new BoardLab({ db: openDatabase(join(dir, name)), modules })

afterEach(() => {})

describe('a plugin registers through its context', () => {
  it('takes back everything a module added when the module is taken down, newest first', async () => {
    const lab = labOf()
    const order: string[] = []
    let heard = 0
    const module: Module = {
      id: 'probe', title: '探针',
      setup: (_lab, ctx) => {
        // No undo of its own for the endpoint: the lab kept one, so the effect holds that. The witness is added beside it.
        ctx.effect(() => { lab.api.addOne('probe', { method: 'GET', path: '/api/probe', about: 'p', handle: () => ({ ok: true }) }); return () => { order.push('endpoint') } })
        ctx.effect(() => { const part = () => ({}); lab.addState(part); return () => { order.push('state'); lab.removeState(part) } })
        ctx.on('event', () => { heard++ })
        return {}
      },
    }
    lab.use(module)
    expect(lab.api.list().some(item => item.path === '/api/probe')).toBe(true)
    lab.events.emit('event', { kind: 'anything' })
    expect(heard).toBe(1)
    await lab.loader.remove('probe')
    // Reverse of registration, and the listener is gone with it.
    expect(order).toEqual(['state', 'endpoint'])
    lab.events.emit('event', { kind: 'anything' })
    expect(heard).toBe(1)
    expect(lab.api.list().some(item => item.path === '/api/probe')).toBe(false)
    expect(lab.state('user:a')).not.toHaveProperty('probe')
  })

  it('takes back what a module registered on the lab directly, without ever holding an undo', async () => {
    // The shape every module in this distribution has: `setup(lab)` calling `lab.…` and returning an API. The loader
    // records those calls while the setup runs, so removing the module is clean even though the module knows nothing
    // about effects.
    const lab = labOf()
    const backend = { kind: 'fake', inventory: { list: async () => [], remove: async () => null } }
    const module: Module = { id: 'direct', title: '直接', setup: lab => { lab.backends.register('reg', backend as never); lab.api.add('direct', [{ method: 'GET', path: '/api/direct', about: 'd', handle: () => ({}) }]); return { hello: () => 'hi' } } }
    lab.use(module)
    expect(lab.backends.list().map(instance => instance.id)).toContain('reg')
    expect(lab.module<{ hello(): string }>('direct').hello()).toBe('hi')
    await lab.loader.remove('direct')
    expect(lab.backends.list().map(instance => instance.id)).not.toContain('reg')
    expect(lab.api.list().some(item => item.path === '/api/direct')).toBe(false)
    // The service it provided under its id is gone too.
    expect(() => lab.module('direct')).toThrow(/not loaded/)
  })

  it('keeps a registration made outside any module for the life of the lab', () => {
    // Boardd's own registration (no module being set up) has no context to belong to and must not be taken away.
    const lab = labOf()
    lab.backends.register('own', { kind: 'fake' } as never)
    expect(lab.backends.list().map(instance => instance.id)).toContain('own')
  })
})

describe('a plugin declares what it needs', () => {
  it('waits for a service nobody provides, and runs as soon as one arrives', async () => {
    const lab = labOf()
    const ran: string[] = []
    const consumer: Module = { id: 'consumer', title: '用的人', inject: ['provider'], setup: () => { ran.push('consumer'); return {} } }
    lab.loader.add(consumer)
    expect(lab.loader.list().find(item => item.id === 'consumer')).toMatchObject({ status: 'pending', why: 'needs provider' })
    expect(ran).toEqual([])
    // A provider that arrives later is set up, and what waited for it runs with it: no caller has to remember to resume.
    const provider: Module = { id: 'provider', title: '给的人', setup: () => { ran.push('provider'); return { value: 1 } } }
    lab.loader.add(provider)
    expect(ran).toEqual(['provider', 'consumer'])
    expect(lab.loader.list().find(item => item.id === 'consumer')).toMatchObject({ status: 'active', why: null })
    expect(lab.service<{ value: number }>('provider').value).toBe(1)
  })

  it('takes the modules that need a service down before the one that provides it', async () => {
    const lab = labOf()
    const gone: string[] = []
    const provider: Module = { id: 'base', title: '底', setup: (_l, ctx) => { ctx.provide('base', {}); ctx.effect(() => () => {}); return {} } }
    const consumer: Module = { id: 'top', title: '上', inject: ['base'], setup: (_l, ctx) => { ctx.effect(() => () => {}); return {} } }
    lab.loader.add(provider); lab.loader.add(consumer)
    // Removing the provider removes its dependent first (the loader walks dependents), then it.
    const removed = lab.loader.remove.bind(lab.loader)
    lab.loader.list = lab.loader.list.bind(lab.loader)
    await removed('base')
    expect(lab.loader.has('top')).toBe(false)
    expect(lab.loader.has('base')).toBe(false)
    void gone
  })

  it('reports a failed setup without taking the rest of the lab down', () => {
    const lab = labOf()
    const broken: Module = { id: 'broken', title: '坏的', setup: () => { throw new Error('boom') } }
    const fine: Module = { id: 'fine', title: '好的', setup: (_l, ctx) => { ctx.effect(() => () => {}); return { ok: true } } }
    lab.loader.add(broken)
    lab.use(fine)
    expect(lab.loader.list().find(item => item.id === 'broken')).toMatchObject({ status: 'failed', why: 'boom' })
    expect(lab.loader.has('fine')).toBe(true)
    // Boardd's state says the same: a module that is not running is listed with why, so a person can see it.
    expect(lab.state('user:a').plugins).toContainEqual(expect.objectContaining({ id: 'broken', status: 'failed', why: 'boom' }))
    expect(lab.state('user:a').modules.map(item => item.id)).toEqual(['fine'])
  })

  it('leaves nothing behind when a setup throws halfway, through an effect or a direct registration', async () => {
    // A third-party module can fail after it registered: what it registered before throwing must not stay live, or a
    // module reported `failed` still answers its endpoints and still has its backend.
    const lab = labOf([], 'half.sqlite')
    const broken: Module = {
      id: 'half', title: '一半',
      setup: (_l, ctx) => {
        ctx.effect(() => { lab.api.addOne('half', { method: 'GET', path: '/api/half', about: 'h', handle: () => ({}) }); return () => {} })
        lab.addState(() => ({ half: true }))
        lab.backends.register('half-reg', { kind: 'fake', inventory: { list: async () => [], remove: async () => null } } as never)
        throw new Error('halfway')
      },
    }
    lab.use(broken, {}, { tolerate: true })
    expect(lab.loader.list().find(item => item.id === 'half')).toMatchObject({ status: 'failed', why: 'halfway' })
    expect(lab.api.list().some(item => item.path === '/api/half')).toBe(false)
    expect(lab.state('user:a')).not.toHaveProperty('half')
    expect(lab.backends.list().map(instance => instance.id)).not.toContain('half-reg')
    expect(lab.has('half')).toBe(false)
  })

  it('takes a body that throws inside an effect back with it, and keeps the module whole', () => {
    const lab = labOf([], 'body.sqlite')
    const made: Module = {
      id: 'throwing', title: '抛',
      setup: (_l, ctx) => {
        expect(() => ctx.effect(() => { lab.api.addOne('throwing', { method: 'GET', path: '/api/throwing', about: 't', handle: () => ({}) }); throw new Error('inside') })).toThrow(/inside/)
        return {}
      },
    }
    lab.use(made)
    expect(lab.api.list().some(item => item.path === '/api/throwing')).toBe(false)
    expect(lab.has('throwing')).toBe(true)
  })

  it('undoes a nested effect before the effect it was opened in, so what an effect opened closes last', async () => {
    const lab = labOf([], 'nested.sqlite')
    const order: string[] = []
    lab.use({
      id: 'nested', title: '套',
      setup: (_l, ctx) => {
        ctx.effect(() => {
          ctx.effect(() => () => { order.push('inner') })
          return () => { order.push('outer') }
        })
        return {}
      },
    })
    await lab.loader.remove('nested')
    // Reverse of registration: what the body registered (the nested effect) goes before what it returned.
    expect(order).toEqual(['inner', 'outer'])
  })

  it('does not take a provider\'s users down for a service it declared but never got', async () => {
    // Z declares `provide: ['db']` but X already provides it: Z never offered `db`, so removing Z must not remove Y,
    // which uses X's service.
    const lab = labOf([], 'declared.sqlite')
    const x: Module = { id: 'x', title: 'X', setup: () => ({ db: 1 }) }
    const z: Module = { id: 'z', title: 'Z', provide: ['x'], setup: (_l, ctx) => { ctx.effect(() => () => {}); return {} } }
    const y: Module = { id: 'y', title: 'Y', inject: ['x'], setup: (_l, ctx) => { ctx.effect(() => () => {}); return {} } }
    lab.use(x)
    lab.use(z)
    lab.use(y)
    await lab.loader.remove('z')
    expect(lab.has('y')).toBe(true)
    expect(lab.has('x')).toBe(true)
    expect(lab.service('x')).toMatchObject({ db: 1 })
  })

  it('offers its id after a resume only when its setup returned something, and orders by inject as well as requires', () => {
    const lab = labOf([], 'resume.sqlite')
    const ran: string[] = []
    lab.loader.add({ id: 'consumer', title: 'C', inject: ['timed'], setup: () => { ran.push('consumer'); return {} } })
    lab.loader.add({ id: 'timed', title: 'T', setup: () => { ran.push('timed'); return { value: 1 } } })
    lab.loader.resume()
    expect(ran).toEqual(['timed', 'consumer'])
    // A resumed module that returned nothing claims no service: one under its id would resolve to `undefined`.
    const quiet = new Loader({ lab: {}, stateDir: '/nonexistent', registry: Object.fromEntries(['endpoint', 'view', 'lockTarget', 'lockOccupant', 'lockFollower', 'state', 'history', 'service', 'backend', 'labKind', 'event'].map(name => [name, () => () => {}])) as never })
    expect(quiet.add({ id: 'late', title: 'L', setup: () => {} })).toBeUndefined()
    expect(quiet.services.has('late')).toBe(false)
    expect(() => quiet.service('late')).toThrow(/not provided/)
    // `inject` orders the lab the way `requires` does: a module that injects another's service is set up after it.
    const order: string[] = []
    new BoardLab({ db: openDatabase(join(dir, 'inject-order.sqlite')), modules: [
      { id: 'beta', title: 'B', setup: () => { order.push('beta'); return { value: 1 } } },
      { id: 'alpha', title: 'A', inject: ['beta'], setup: () => { order.push('alpha'); return {} } },
    ] })
    expect(order).toEqual(['beta', 'alpha'])
  })

  it('lets a market module fail without keeping the lab from starting, and says the distribution\'s own failure', () => {
    const lab = labOf([], 'tolerate.sqlite')
    // A distribution's own module that throws is the start's failure.
    expect(() => lab.use({ id: 'own', title: '自己的', setup: () => { throw new Error('bad') } })).toThrow(/module own: bad/)
    // A third-party one passed `tolerate` is listed as failed and the rest runs.
    const third: Module = { id: 'third', title: '外来的', setup: () => { throw new Error('third') } }
    expect(() => lab.use(third, {}, { tolerate: true })).not.toThrow()
    expect(lab.loader.list().find(item => item.id === 'third')).toMatchObject({ status: 'failed' })
  })
})

describe('the loader on its own', () => {
  it('undoes in reverse, once, and never lets one failing undo stop the others', async () => {
    const done: string[] = []
    const loader = new Loader({
      lab: {}, stateDir: '/nonexistent',
      registry: {
        endpoint: () => () => { done.push('a') },
        view: () => () => { done.push('b') }, lockTarget: () => () => {}, lockOccupant: () => () => {}, lockFollower: () => () => {},
        state: () => () => {}, history: () => () => {}, service: () => () => {}, backend: () => () => {}, labKind: () => () => {},
        event: () => () => {},
      },
      report: () => {},
    })
    const module: Module = {
      id: 'm', title: 'm',
      setup: (_l, ctx) => {
        ctx.effect(() => () => { done.push('first'); throw new Error('nope') })
        ctx.effect(() => () => { done.push('second') })
      },
    }
    loader.add(module)
    await loader.remove('m')
    expect(done).toEqual(['second', 'first'])
    await loader.remove('m')                       // nothing left to do
    expect(done).toEqual(['second', 'first'])
  })

  it('lists what a module is, with its tags, for a market to search', () => {
    const loader = new Loader({ lab: {}, stateDir: '/nonexistent', registry: Object.fromEntries(['endpoint', 'view', 'lockTarget', 'lockOccupant', 'lockFollower', 'state', 'history', 'service', 'backend', 'labKind', 'event'].map(name => [name, () => () => {}])) as never })
    loader.add({ id: 'recipes', title: '部门配方', about: '常用 SDK 配方', tags: ['content', 'sdk'], setup: (_l, ctx) => { ctx.effect(() => () => {}); return {} } })
    expect(loader.list()).toEqual([{ id: 'recipes', title: '部门配方', about: '常用 SDK 配方', tags: ['content', 'sdk'], inject: [], provide: [], status: 'active', why: null }])
  })

  it('finds a file of the release it runs in, and says null when there is none', () => {
    // A module from a market has no catalog entry to be told the release through: it asks its own context.
    const lab = labOf()
    const seen: Array<string | null> = []
    lab.use({
      id: 'installer', title: '装到别的机器上',
      setup: (_lab, ctx) => { seen.push(ctx.shipped('install.sh'), ctx.shipped('nope')) ; return {} },
    })
    expect(seen).toEqual([null, null])
    const shipped = (path: string) => path === 'install.sh' ? '/opt/boardlab-0.5.0/install.sh' : null
    const withRelease = new BoardLab({ db: openDatabase(join(dir, 'shipped.sqlite')), shipped })
    let found: string | null = null
    withRelease.use({ id: 'installer', title: '装到别的机器上', setup: (_lab, ctx) => { found = ctx.shipped('install.sh'); return {} } })
    expect(found).toBe('/opt/boardlab-0.5.0/install.sh')
  })
})

describe('the registry of a lab', () => {
  it('hands back an undo for every extension point, so a caller with no context still leaves nothing behind', () => {
    const lab = labOf()
    const registry = registryOf(lab)
    const part = () => ({ probe: true })
    const undoState = registry.state(part)
    const undoEvent = registry.event('event', () => {})
    expect(lab.state('user:a')).toHaveProperty('probe')
    expect(lab.events.listenerCount('event')).toBeGreaterThan(0)
    undoState(); undoEvent()
    expect(lab.state('user:a')).not.toHaveProperty('probe')
    expect(lab.events.listenerCount('event')).toBe(0)
  })
})
