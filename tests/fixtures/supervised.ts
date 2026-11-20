/**
 * A distribution for the supervisor test: the bare CLI plus a fake module with a stream that stays open until its
 * client leaves. Its release identity comes from release.json beside the built cli.js, so two builds differ.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventStream } from '../../src/core/api.ts'
import { createCli, runIfMain } from '../../src/cli/main.ts'

const identity = () => {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'release.json'), 'utf8')) as { version: string, revision: string } }
  catch { return { version: 'dev', revision: 'dev' } }
}

export const cli = createCli({
  groups: [], identity,
  catalog: [{
    id: 'ticker', about: 'a stream for tests',
    create: () => ({
      id: 'ticker', title: 'ticker',
      setup: lab => lab.api.add('ticker', [{
        method: 'GET', path: '/api/ticker', about: 'a tick every 100 ms, with the pid that sends it',
        handle: () => new EventStream((emit, _end, signal) => {
          let n = 0
          const timer = setInterval(() => emit('tick', { n: n++, pid: process.pid }), 100)
          signal.addEventListener('abort', () => clearInterval(timer), { once: true })
        }),
      }]),
    }),
  }],
})
runIfMain(cli, import.meta.url)
