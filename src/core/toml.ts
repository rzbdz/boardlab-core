/** TOML export of the inventory for older tools. */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable
export interface TomlTable { [key: string]: TomlValue }

export function formatToml(root: TomlTable): string {
  const lines: string[] = []
  const emit = (table: TomlTable, path: string[]) => {
    const scalars = Object.entries(table).filter(([, value]) => typeof value !== 'object' || Array.isArray(value))
    if (path.length && scalars.length) lines.push('', `[${path.map(formatKey).join('.')}]`)
    for (const [key, value] of scalars) lines.push(`${formatKey(key)} = ${formatValue(value)}`)
    for (const [key, value] of Object.entries(table)) {
      if (typeof value === 'object' && !Array.isArray(value)) emit(value, [...path, key])
    }
  }
  emit(root, [])
  return lines.join('\n').trimStart() + '\n'
}

const formatKey = (key: string) => /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
const formatValue = (value: TomlValue): string =>
  Array.isArray(value) ? `[${value.map(formatValue).join(', ')}]` : typeof value === 'string' ? JSON.stringify(value) : String(value)
