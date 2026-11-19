import { describe, expect, it } from 'vitest'
import { workerExecArgv } from '../src/server/supervisor.ts'

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
})
