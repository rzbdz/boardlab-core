/**
 * Files shipped with a boardlab distribution (its skill, page, firmware, externals). Built, the CLI is dist/*.js one
 * level below the distribution; from source it is a few levels below (src/cli/ here, core/src/cli/ in a distribution
 * that has the core as a submodule). The nearest directory up from here that has the path wins.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function shipped(path: string, accept: (found: string) => boolean = existsSync): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, path)
    if (accept(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
