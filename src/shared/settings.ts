/**
 * Reading a module's settings, as boardd's configuration has them: the few checks every module makes on what a person
 * wrote, said in one place so a module's own code and the catalog entry that makes it read them the same way.
 *
 * In `shared` because both sides need it and it depends on nothing: a distribution's catalog entry, a module from a
 * market (which imports its SDK), and the CLI that reads a configuration file before boardd does.
 *
 * `ModuleSettings` is named apart from the kernel's `Settings` (a key/value store a module reaches at run time), which
 * the SDK also hands out.
 */
export type ModuleSettings = Record<string, unknown>

/** Backend instance ids (`instances`), each `<id>` naming boards `<id>-<device>`. */
export function instances(settings: ModuleSettings, fallback: string): string[] {
  const value = settings.instances ?? [fallback]
  if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id))) {
    throw new Error(`instances 要是实例名的数组，例如 ["${fallback}"]`)
  }
  return value as string[]
}

export function text(settings: ModuleSettings, key: string): string | undefined {
  const value = settings[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value) throw new Error(`${key} 要是字符串`)
  return value
}

export function number(settings: ModuleSettings, key: string): number | undefined {
  const value = settings[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${key} 要是正数`)
  return value
}
