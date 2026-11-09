#!/usr/bin/env node
/**
 * The repository's architecture check: reads architecture.json and fails on any import, name or file that breaks it.
 *
 *   layers      each layer imports only the layers it may (type-only where it says), Node built-ins only where allowed,
 *               and only the npm packages it lists;
 *   modules     a module imports only core, shared and the modules it declares; declared dependencies have no cycles;
 *               every pluggable module has an index.ts that sets it up under its own id, requires what it imports, and
 *               has a catalog entry of its own (src/modules/<id>/catalog.ts) offering it to boardd;
 *   core        no product, vendor or transport names in core code, and no configuration read from the environment;
 *   size        no source file over maxLines, except the debts listed (which must still exist and still be over).
 *
 * `node <core>/scripts/check-architecture.mjs [--json] [root]` (root: the current directory); the core and every
 * distribution run it on themselves in `pnpm check`, the build and the tests. A distribution's architecture.json maps
 * its imports of the core into the core's layers (`aliases`) and states its modules' rules.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = /\.(ts|tsx|mjs|js)$/
const BUILTINS = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : SOURCE.test(name) ? [path] : []
  })
}

/** Code with comments blanked out (lines kept), so names in comments do not count and line numbers stay right. */
function stripComments(text) {
  let out = '', i = 0, quote = null
  while (i < text.length) {
    const c = text[i], next = text[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += next ?? ''; i += 2; continue }
      if (c === quote) quote = null
      i++
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') { out += ' '; i++ }
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else {
      if (c === '\'' || c === '"' || c === '`') quote = c
      out += c
      i++
    }
  }
  return out
}

/** Every import of a file: `import … from`, `export … from`, side-effect imports and dynamic `import()`. */
function importsOf(text) {
  const code = stripComments(text)
  const found = []
  const patterns = [
    // The clause is one of the shapes an import or re-export takes, so a match never runs on into the next statement.
    /(^|[\n;])\s*(import|export)\s+(type\s+)?((?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*\s*as\s+[\w$]+|\*)|[\w$]+)\s*from\s*['"]([^'"]+)['"]/g,
    /(^|[\n;])\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const [index, pattern] of patterns.entries()) {
    for (const match of code.matchAll(pattern)) {
      const line = code.slice(0, match.index + match[0].length).split('\n').length
      if (index === 0) {
        const clause = match[4] ?? ''
        // `import type {…}` and `import { type A, type B }` bring no code along.
        const typeOnly = !!match[3] || (/^\{[^}]*\}$/.test(clause.trim()) && clause.replace(/[{}\s]/g, '').split(',').filter(Boolean).every(part => part.startsWith('type')))
        found.push({ spec: match[5], line, typeOnly })
      } else found.push({ spec: index === 1 ? match[2] : match[1], line, typeOnly: false, dynamic: index === 2 })
    }
  }
  return found
}

export function checkArchitecture(root = process.cwd()) {
  const rules = JSON.parse(readFileSync(join(root, 'architecture.json'), 'utf8'))
  const violations = []
  const report = (file, line, rule, message) => violations.push({ file, line, rule, message })
  const rel = path => relative(root, path).split(sep).join('/')
  const layers = Object.entries(rules.layers).map(([name, layer]) => ({ name, ...layer }))
  // A layer named by file patterns (`src/modules/*/cli.ts`) wins over one named by a directory.
  const glob = pattern => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`)
  const layerOf = path => layers.find(layer => (layer.paths ?? []).some(pattern => glob(pattern).test(path)))
    ?? layers.find(layer => layer.path && (path === layer.path || path.startsWith(`${layer.path}/`)))
  const moduleOf = path => path.startsWith('src/modules/') ? path.split('/')[2] : null
  const libraries = new Set(Object.keys(rules.modules?.libraries ?? {}))
  const deps = rules.modules?.dependencies ?? {}
  // A package that is part of the layering (the core, to a distribution): `boardlab-core/core/lab.ts` is core/src/core/lab.ts.
  const aliases = Object.entries(rules.aliases ?? {})
  const maxLines = rules.maxLines ?? 800, debts = rules.debts ?? {}
  const files = (rules.roots ?? ['src']).flatMap(dir => walk(join(root, dir))).map(rel)
  const moduleImports = new Map()

  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    const layer = layerOf(file)
    if (!layer) { report(file, 1, 'layers', 'not in any layer of architecture.json'); continue }
    for (const { spec, line, typeOnly } of importsOf(text)) {
      const alias = aliases.find(([prefix]) => spec.startsWith(prefix))
      if (spec.startsWith('.') || alias) {
        const target = alias ? `${alias[1]}${spec.slice(alias[0].length)}` : rel(resolve(root, dirname(file), spec))
        const to = layerOf(target)
        if (!to) { report(file, line, 'layers', `imports ${target}, outside every layer`); continue }
        if (to.name !== layer.name) {
          const entry = (layer.entries ?? []).includes(target)
          if (!layer.may.includes(to.name) && !entry) report(file, line, 'layers', `${layer.name} may not import ${to.name} (${target})`)
          else if ((layer.typeOnly ?? []).includes(to.name) && !typeOnly && !entry) report(file, line, 'layers', `${layer.name} may import only types from ${to.name} (${target}); use \`import type\``)
        }
        const from = moduleOf(file), into = moduleOf(target)
        if (from && into && from !== into) {
          if (!(deps[from] ?? []).includes(into)) report(file, line, 'modules', `module ${from} imports module ${into} without declaring it in architecture.json`)
          if (!moduleImports.has(from)) moduleImports.set(from, new Set())
          moduleImports.get(from).add(into)
        }
      } else if (BUILTINS.has(spec) || spec.startsWith('node:')) {
        if (layer.node === false) report(file, line, 'layers', `${layer.name} runs in a browser and may not import ${spec}`)
      } else {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        const allowed = layer.packages ?? []
        if (!allowed.includes(name) && !allowed.includes(spec)) report(file, line, 'layers', `${layer.name} may not use the package ${spec} (allowed: ${allowed.join(', ') || 'none'})`)
      }
    }
    if (layer.name === 'core') {
      const code = stripComments(text).split('\n')
      for (const [index, source] of code.entries()) {
        for (const word of rules.core?.forbidden ?? []) {
          const match = source.match(new RegExp(word, 'i'))
          if (match) report(file, index + 1, 'core', `names a product or transport (${match[0]}); the core knows backends only through their contract`)
        }
        if (rules.core?.env === false && /\bprocess\.env\b/.test(source)) report(file, index + 1, 'core', 'reads the environment; configuration comes in through options')
      }
    }
    const lines = text.split('\n').length
    if (lines > maxLines && !debts[file]) report(file, lines, 'size', `${lines} lines, over ${maxLines}: split it`)
  }

  // Debts must still be owed.
  for (const [file] of Object.entries(debts).filter(([key]) => key !== '$comment')) {
    if (!files.includes(file)) report('architecture.json', 1, 'size', `debt ${file} does not exist; remove it`)
    else if (readFileSync(join(root, file), 'utf8').split('\n').length <= maxLines) report('architecture.json', 1, 'size', `${file} is within ${maxLines} lines now; remove its debt`)
  }
  if (!rules.modules) return violations           // a repository of no modules (the core itself)

  // Declared module dependencies: known modules, no cycles.
  const known = new Set(readdirSync(join(root, 'src/modules')).filter(name => statSync(join(root, 'src/modules', name)).isDirectory()))
  for (const name of known) if (!(name in deps)) report(`src/modules/${name}`, 1, 'modules', `module ${name} is not declared in architecture.json`)
  for (const [name, list] of Object.entries(deps)) {
    if (!known.has(name)) report('architecture.json', 1, 'modules', `declares module ${name}, which does not exist`)
    for (const dep of list) if (!known.has(dep)) report('architecture.json', 1, 'modules', `${name} depends on ${dep}, which does not exist`)
  }
  const visiting = new Set(), done = new Set()
  const visit = (name, path) => {
    if (done.has(name)) return
    if (visiting.has(name)) return report('architecture.json', 1, 'modules', `module dependencies form a cycle: ${[...path, name].join(' → ')}`)
    visiting.add(name)
    for (const dep of deps[name] ?? []) visit(dep, [...path, name])
    visiting.delete(name)
    done.add(name)
  }
  for (const name of Object.keys(deps)) visit(name, [])

  // Pluggable modules: set up under their own id, requiring the modules they import, and offered to boardd by a catalog
  // entry of their own (src/modules/<id>/<catalog>), which is what puts them in a distribution.
  const catalogFile = rules.modules.catalog ?? 'catalog.ts'
  for (const name of known) {
    if (libraries.has(name)) {
      if (existsSync(join(root, 'src/modules', name, 'index.ts')) && /\bsetup\s*\(/.test(readFileSync(join(root, 'src/modules', name, 'index.ts'), 'utf8'))) {
        report(`src/modules/${name}/index.ts`, 1, 'modules', `${name} is declared a library but sets itself up as a module`)
      }
      continue
    }
    const index = `src/modules/${name}/index.ts`
    if (!files.includes(index)) { report(`src/modules/${name}`, 1, 'modules', `module ${name} has no index.ts setting it up`); continue }
    const code = stripComments(readFileSync(join(root, index), 'utf8'))
    const constant = [...code.matchAll(/(?:export\s+)?const\s+([A-Z_]+)\s*=\s*['"]([^'"]+)['"]/g)].find(match => match[2] === name)?.[1]
    if (!new RegExp(`\\bid:\\s*(['"]${name}['"]${constant ? `|${constant}\\b` : ''})`).test(code)) report(index, 1, 'modules', `module ${name} must set itself up with id '${name}'`)
    if (!/\bsetup\s*\(/.test(code)) report(index, 1, 'modules', `module ${name} has no setup()`)
    const requires = code.match(/\brequires:\s*\[([^\]]*)\]/)?.[1] ?? ''
    for (const dep of moduleImports.get(name) ?? []) {
      if (libraries.has(dep)) continue
      const named = new RegExp(`['"]${dep}['"]|\\b${dep.toUpperCase().replace(/-/g, '_')}\\b`).test(requires)
      if (!named) report(index, 1, 'modules', `module ${name} uses module ${dep} but does not list it in requires`)
    }
    const entry = `src/modules/${name}/${catalogFile}`
    if (!files.includes(entry)) report(`src/modules/${name}`, 1, 'modules', `module ${name} has no ${catalogFile} offering it to boardd`)
    else if (!new RegExp(`\\bid:\\s*['"]${name}['"]`).test(stripComments(readFileSync(join(root, entry), 'utf8')))) report(entry, 1, 'modules', `${entry} must offer the module under id '${name}'`)
  }
  return violations
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const root = resolve(args.find(arg => !arg.startsWith('-')) ?? process.cwd())
  const violations = checkArchitecture(root)
  if (args.includes('--json')) console.log(JSON.stringify(violations, null, 2))
  else if (!violations.length) console.log('architecture: ok')
  else for (const item of violations) console.error(`${item.file}:${item.line}  [${item.rule}] ${item.message}`)
  process.exit(violations.length ? 1 : 0)
}
