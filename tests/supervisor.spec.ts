import { describe, expect, it } from 'vitest'
import { SHARED_DATABASE_ENV, workerEnv, workerExecArgv } from '../src/server/supervisor.ts'

describe('supervisor workers', () => {
  it('start without the unstable V8 tiers on riscv64 only, and take their flags from BOARDLAB_WORKER_NODE_FLAGS when set', () => {
    expect(workerExecArgv('riscv64', {}, [])).toEqual(['--single-threaded', '--no-sparkplug', '--no-maglev'])
    // The supervisor's own flags (the unit's --no-sparkplug) are kept and not repeated.
    expect(workerExecArgv('riscv64', {}, ['--no-sparkplug'])).toEqual(['--no-sparkplug', '--single-threaded', '--no-maglev'])
    expect(workerExecArgv('x64', {}, ['--inspect'])).toEqual(['--inspect'])
    expect(workerExecArgv('riscv64', { BOARDLAB_WORKER_NODE_FLAGS: '--no-opt  --no-opt' }, [])).toEqual(['--no-opt'])
    expect(workerExecArgv('riscv64', { BOARDLAB_WORKER_NODE_FLAGS: '' }, ['--no-sparkplug'])).toEqual(['--no-sparkplug'])
    expect(workerExecArgv('x64', { BOARDLAB_WORKER_NODE_FLAGS: '--no-maglev' }, [])).toEqual(['--no-maglev'])
  })

  it('are marked as sharing the database when another worker is still alive, so only a first start restores it', () => {
    const live = { isDead: () => false }, dead = { isDead: () => true }
    expect(workerEnv({ A: '1' }, [])).toEqual({ A: '1', [SHARED_DATABASE_ENV]: '0' })
    expect(workerEnv({}, [dead])[SHARED_DATABASE_ENV]).toBe('0')
    expect(workerEnv({}, [dead, live])[SHARED_DATABASE_ENV]).toBe('1')
  })
})
