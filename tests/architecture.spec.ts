import { describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error: a plain ES module script without type declarations
import { checkArchitecture } from '../scripts/check-architecture.mjs'

type Violation = { file: string, line: number, rule: string, message: string }
const root = join(import.meta.dirname, '..')
const listed = (dir: string) => (checkArchitecture(dir) as Violation[]).map(item => `${item.file} ${item.rule}: ${item.message}`)

function scratch(run: (write: (path: string, text: string) => void, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'arch-'))
  try {
    run((path, text) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text) }, dir)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('architecture', () => {
  it('holds for the core', () => {
    expect(checkArchitecture(root) as Violation[]).toEqual([])
  })

  it('catches the core naming a product, reading the environment, and code outside every layer', () => {
    scratch((write, copy) => {
      cpSync(join(root, 'architecture.json'), join(copy, 'architecture.json'))
      cpSync(join(root, 'src'), join(copy, 'src'), { recursive: true })
      write('src/core/leak.ts', "export const port = process.env.BSP_PORT\nexport const kind = 'bsp'\n")
      write('src/ui/page.ts', "export const page = 1\n")
      expect(listed(copy)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^src\/core\/leak\.ts core: names a product/),
        expect.stringMatching(/^src\/core\/leak\.ts core: reads the environment/),
        expect.stringMatching(/^src\/ui\/page\.ts layers: not in any layer/),
      ]))
    })
  })

  it('checks a distribution: its imports of the core, its modules, their dependencies and catalog entries', () => {
    scratch((write, dist) => {
      write('architecture.json', JSON.stringify({
        aliases: { 'boardlab-core/': 'core/src/' },
        layers: {
          core: { paths: ['core/src/core/*'], may: [] },
          ui: { path: 'src/ui', may: [], node: false },
          modules: { path: 'src/modules', may: ['core'], packages: [] },
        },
        modules: { dependencies: { relays: [], racks: [], rogue: [] }, libraries: {} },
      }))
      write('src/modules/relays/index.ts', "import type { Module } from 'boardlab-core/core/module.ts'\nexport const relays: Module = { id: 'relays', title: 'r', setup() {} }\n")
      write('src/modules/relays/catalog.ts', "export const entry = { id: 'relays' }\n")
      // Uses another module it does not declare, has no catalog entry, and reaches into a frontend.
      write('src/ui/page.ts', "export const mountPage = () => {}\n")
      write('src/modules/racks/index.ts', "import { relays } from '../relays/index.ts'\nimport { mountPage } from '../../ui/page.ts'\nexport const racks = { id: 'racks', setup() {}, relays, mountPage }\n")
      // Not declared at all, and sets itself up under another id.
      write('src/modules/zigbee/index.ts', "export const zigbee = { id: 'zb', setup() {} }\n")
      expect(listed(dist)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^src\/modules\/racks\/index\.ts modules: module racks imports module relays without declaring it/),
        expect.stringMatching(/^src\/modules\/racks\/index\.ts layers: modules may not import ui \(src\/ui\/page\.ts\)/),
        expect.stringMatching(/^src\/modules\/racks modules: module racks has no catalog\.ts/),
        expect.stringMatching(/^architecture\.json modules: declares module rogue, which does not exist/),
        expect.stringMatching(/^src\/modules\/zigbee modules: module zigbee is not declared/),
        expect.stringMatching(/^src\/modules\/zigbee\/index\.ts modules: module zigbee must set itself up with id 'zigbee'/),
      ]))
      expect(listed(dist).some(line => line.startsWith('src/modules/relays'))).toBe(false)
    })
  })
})
