/**
 * The bare distribution: boardlab with no modules. boardd runs, takes locks and serves its API and page, but has no
 * backend to reach boards through; distributions (better-boardlab) add theirs. It is what this repository builds, and
 * the smallest example of a distribution's entry.
 */
import { createCli, runIfMain } from '../src/cli/main.ts'

export const cli = createCli({ groups: [], catalog: [] })
export const main = cli.main
runIfMain(cli, import.meta.url)
