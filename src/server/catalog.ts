/**
 * The modules a distribution offers boardd, and how each is made from its settings in boardd's configuration. A
 * distribution hands its catalog to boardd (`startBoardd`) and to the CLI (`createCli`); boardd loads the ones its
 * configuration selects, in the order their `requires` need.
 */
import type { Module } from '../core/module.ts'

/** What making a module may need from the machine boardd runs on. */
export interface ModuleContext {
  stateDir: string
  /** A file shipped with this distribution (`externals/bsp/bin/bsp`, say), or null. */
  shipped(path: string): string | null
  /** boardd's timing settings (`timing` in its configuration), for modules that take some. */
  timing: Record<string, unknown>
}

export type Settings = Record<string, unknown>

export interface CatalogEntry {
  id: string
  about: string
  create(settings: Settings, context: ModuleContext): Module
}

/** The modules for a selection ({id: settings}), from the catalog. */
export function createModules(catalog: CatalogEntry[], selection: Record<string, Settings>, context: ModuleContext): Module[] {
  const unknown = Object.keys(selection).filter(id => !catalog.some(entry => entry.id === id))
  if (unknown.length) throw new Error(`没有这些模块：${unknown.join(', ')}（有：${catalog.map(entry => entry.id).join(', ') || '（无）'}）`)
  return catalog.filter(entry => entry.id in selection).map(entry => {
    try { return entry.create(selection[entry.id] ?? {}, context) }
    catch (error) { throw new Error(`模块 ${entry.id} 的设置不对：${(error as Error).message}`) }
  })
}

// ---------- reading settings, for modules' catalog entries ----------

/** Backend instance ids (`instances`), each `<id>` naming boards `<id>-<device>`. */
export function instances(settings: Settings, fallback: string): string[] {
  const value = settings.instances ?? [fallback]
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id))) {
    throw new Error(`instances 要是实例名的数组，例如 ["${fallback}"]`)
  }
  return value as string[]
}

export function text(settings: Settings, key: string): string | undefined {
  const value = settings[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value) throw new Error(`${key} 要是字符串`)
  return value
}

export function number(settings: Settings, key: string): number | undefined {
  const value = settings[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${key} 要是正数`)
  return value
}
