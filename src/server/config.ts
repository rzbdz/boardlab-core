/**
 * boardd's configuration: which modules it loads with their settings, and its timings. It is read from `--config`,
 * `$BOARDLAB_CONFIG`, or `boardd.json` in the state directory; without one boardd loads every module with its defaults.
 *
 *   {
 *     "modules": { "bsp": { "instances": ["bsp"] } },          // or a list of ids: ["local", "script-slots"]
 *     "timing": { "boot": { "firstMs": 8000 }, "console": { "watchIdleMs": 30000 }, "scan": { "rounds": 2 }, "syncMs": 60000 }
 *   }
 *
 * `timing.boot`, `timing.console`, `syncMs` and `reapMs` are the core's; any other group (`scan`, say) is a module's,
 * handed to modules through their context.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConsoleTiming } from '../core/consoles.ts'
import type { BootTiming } from '../core/download.ts'
import type { Settings } from './catalog.ts'

export interface BoarddConfig {
  modules: Record<string, Settings>
  timing: { boot?: Partial<BootTiming>, console?: Partial<ConsoleTiming>, syncMs?: number, reapMs?: number, [group: string]: unknown }
  /** Where it was read from, if anywhere. */
  source: string | null
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function timings(value: unknown, where: string): Record<string, number> | undefined {
  if (value === undefined) return undefined
  if (!isObject(value) || Object.values(value).some(item => typeof item !== 'number' || !Number.isFinite(item) || item < 0)) throw new Error(`${where} 要是 {名字: 毫秒数}`)
  return value as Record<string, number>
}

/**
 * Check a configuration as written; `modules` given as a list of ids takes each with its defaults, and left out takes
 * every module the distribution has (`available`).
 */
export function parseConfig(raw: unknown, source: string | null = null, available: string[] = []): BoarddConfig {
  const where = source ?? '配置'
  if (!isObject(raw)) throw new Error(`${where} 要是一个 JSON 对象`)
  let modules: Record<string, Settings>
  if (raw.modules === undefined) modules = Object.fromEntries(available.map(id => [id, {}]))
  else if (Array.isArray(raw.modules) && raw.modules.every(id => typeof id === 'string')) modules = Object.fromEntries((raw.modules as string[]).map(id => [id, {}]))
  else if (isObject(raw.modules) && Object.values(raw.modules).every(isObject)) modules = raw.modules as Record<string, Settings>
  else throw new Error(`${where} 的 modules 要是模块名的数组，或 {模块名: 设置}`)
  const timing = raw.timing === undefined ? {} : raw.timing
  if (!isObject(timing)) throw new Error(`${where} 的 timing 要是对象`)
  const ms = (key: string) => {
    const value = timing[key]
    if (value !== undefined && (typeof value !== 'number' || value <= 0)) throw new Error(`${where} 的 timing.${key} 要是正数`)
    return value as number | undefined
  }
  const groups = Object.fromEntries(Object.entries(timing).filter(([key, value]) => isObject(value) && key !== 'boot' && key !== 'console')
    .map(([key, value]) => [key, timings(value, `${where} 的 timing.${key}`)]))
  return {
    modules, source,
    timing: { ...groups, boot: timings(timing.boot, `${where} 的 timing.boot`), console: timings(timing.console, `${where} 的 timing.console`), syncMs: ms('syncMs'), reapMs: ms('reapMs') },
  }
}

/** The configuration boardd runs with: from `file`, or `$BOARDLAB_CONFIG`, or `boardd.json` in its state directory. */
export function loadConfig(stateDir: string, file: string | undefined, available: string[]): BoarddConfig {
  const path = file ?? process.env.BOARDLAB_CONFIG ?? join(stateDir, 'boardd.json')
  if (!file && !process.env.BOARDLAB_CONFIG && !existsSync(path)) return parseConfig({}, null, available)
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { throw new Error(`读不了 boardd 的配置 ${path}：${(error as Error).message}`) }
  return parseConfig(raw, path, available)
}
