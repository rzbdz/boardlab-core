/**
 * A module's own `boardlab` commands, for a module that lives in a market: boardd loads the module's `cli` file and
 * describes its commands, and a CLI that does not have the module lists them and runs one through that boardd.
 *
 * The chain is exercised with a real file: a module's `cli.js` in a temp directory, loaded the way boardd loads it.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Command } from '../src/cli/command.ts'
import { describe as describeGroup, loadCommands } from '../src/cli/market-cli.ts'
import { withMarketCommands } from '../src/cli/market-commands.ts'

const root = mkdtempSync(join(tmpdir(), 'boardlab-market-cli-'))

/** A module's cli file: two commands, one of them under a heading of its own. */
function cliFile(name: string, body: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'cli.js')
  writeFileSync(file, body)
  return file
}

const CLI = `
export const commands = {
  id: 'thing', title: '东西', summary: '一个东西的命令',
  commands: [
    { name: 'things', usage: ['things', '\\t列出东西'], async run(ctx) { ctx.out({ listed: true }, () => console.log('listed')) } },
    { name: 'local-tool', usage: ['local-tool', '\\t本机的事'], standalone: true, async run() {} },
  ],
}
`

describe('a market module\'s commands', () => {
  it('are read from the file it brings, with its heading and which are standalone', async () => {
    const { group, problem } = await loadCommands(cliFile('read', CLI), 'thing')
    expect(problem).toBeNull()
    expect(group).toMatchObject({ id: 'thing', title: '东西', summary: '一个东西的命令' })
    expect(group!.commands.map(command => command.name)).toEqual(['things', 'local-tool'])
    const described = describeGroup(group!)
    expect(described[0]).toEqual({ name: 'things', usage: ['things', '\t列出东西'], group: { id: 'thing', title: '东西', summary: '一个东西的命令' } })
    expect(described[1]).toMatchObject({ name: 'local-tool', standalone: true })
  })

  it('are a problem, not a crash, when the file has no commands or cannot be loaded', async () => {
    const empty = await loadCommands(cliFile('empty', 'export const other = 1\n'), 'thing')
    expect(empty.group).toBeNull()
    expect(empty.problem).toMatch(/没有导出 commands/)
    const broken = await loadCommands(cliFile('broken', 'throw new Error("no dependency here")\n'), 'thing')
    expect(broken.group).toBeNull()
    expect(broken.problem).toMatch(/加载不了/)
    const missing = await loadCommands(join(root, 'nothing-here.ts'), 'thing')
    expect(missing.problem).toMatch(/加载不了/)
  })

  it('become commands a CLI can list, grouped by the heading the module gave, and never replace a built-in', () => {
    const run = async () => {}
    const builtIn: Command = { name: 'lock', usage: ['lock <板名>'], run }
    const offered = [
      { name: 'things', usage: ['things'], group: { id: 'thing', title: '东西' } },
      // A market may not take a command this build already has.
      { name: 'lock', usage: ['lock'], group: { id: 'thing', title: '东西' } },
      { name: 'other', usage: ['other'], group: { id: 'other', title: '别的', summary: '另一组' } },
    ]
    const groups = withMarketCommands([{ title: '板子', commands: [builtIn] }], offered, () => ({} as never))
    expect(groups.map(group => group.title)).toEqual(['板子', '东西', '别的'])
    expect(groups[1]!.commands.map(command => command.name)).toEqual(['things'])
    expect(groups[2]!.summary).toBe('另一组')
    // Two markets offering one name is an error to settle, never a silent winner.
    expect(() => withMarketCommands([], [offered[0]!, offered[0]!], () => ({} as never))).toThrow(/只留一个/)
  })

  it('run through the boardd that has the module, passing the words as typed', async () => {
    const groups = withMarketCommands([], [{ name: 'things', usage: ['things'], group: { id: 'thing', title: '东西' } }], () => ({
      proxy: async (args: string[], json: boolean) => { seen = { args, json }; return { code: 0 } },
    }) as never)
    let seen: { args: string[], json: boolean } | null = null
    const command = groups[0]!.commands[0]!
    await command.run({ argv: ['--tag', 'a b', '--json'], json: true } as never)
    expect(seen).toEqual({ args: ['things', '--tag', 'a b', '--json'], json: true })
    expect(process.exitCode ?? 0).toBe(0)
  })
})
