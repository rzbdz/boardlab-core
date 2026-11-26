/**
 * The modules a distribution offers boardd, and how each is made from its settings in boardd's configuration. A
 * distribution hands its catalog to boardd (`startBoardd`) and to the CLI (`createCli`); boardd loads the ones its
 * configuration selects, in the order their `requires` need.
 *
 * The shapes are the core's (`core/catalog.ts`), because a module from a market is made the same way and its SDK hands
 * out the same types. The readers are `shared`'s, so a module reads its settings with what the catalog does.
 */
import type { Module } from '../core/module.ts'
import type { CatalogEntry, ModuleContext } from '../core/catalog.ts'
import type { Settings } from '../shared/settings.ts'

export * from '../core/catalog.ts'
export { instances, number, text } from '../shared/settings.ts'
export type { Settings } from '../shared/settings.ts'

/** The modules for a selection ({id: settings}), from the catalog. */
export function createModules(catalog: CatalogEntry[], selection: Record<string, Settings>, context: ModuleContext): Module[] {
  const unknown = Object.keys(selection).filter(id => !catalog.some(entry => entry.id === id))
  if (unknown.length) throw new Error(`没有这些模块：${unknown.join(', ')}（有：${catalog.map(entry => entry.id).join(', ') || '（无）'}）`)
  return catalog.filter(entry => entry.id in selection).map(entry => {
    try { return entry.create(selection[entry.id] ?? {}, context) }
    catch (error) { throw new Error(`模块 ${entry.id} 的设置不对：${(error as Error).message}`) }
  })
}
