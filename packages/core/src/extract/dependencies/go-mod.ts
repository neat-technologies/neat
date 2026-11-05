import type { ResolvedDependency, ServiceInventory } from './resolved.js'

// go.mod as a resolved inventory (dependency-inventory.md §3). Since Go 1.17 a
// module's go.mod lists every module its build needs. Direct requirements carry
// no comment, and the rest are marked `// indirect`. So for `go >= 1.17` the
// require list is the resolved build list. Before 1.17 indirect requirements
// can be missing, and the inventory is `partial`.
//
// go.mod doesn't record which direct requirement pulls an indirect one in (that
// takes `go mod graph`), so `introducedBy` stays empty for Go. `replace`
// directives that point at another module version substitute that version, and
// ones that point at a local path are first-party code and drop out.
//
// The Go standard library is not listed: the toolchain that actually builds the
// service isn't recorded in go.mod (the `go` line is a minimum), so NEAT doesn't
// guess it.

interface Requirement {
  module: string
  version: string
  indirect: boolean
}

function stripComment(line: string): { code: string; comment: string } {
  const at = line.indexOf('//')
  return at < 0 ? { code: line.trim(), comment: '' } : { code: line.slice(0, at).trim(), comment: line.slice(at + 2).trim() }
}

function parseDirectiveLines(source: string, directive: 'require' | 'replace'): Array<{ code: string; comment: string }> {
  const out: Array<{ code: string; comment: string }> = []
  const lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const { code, comment } = stripComment(lines[i] ?? '')
    if (code === `${directive} (`) {
      for (i++; i < lines.length; i++) {
        const inner = stripComment(lines[i] ?? '')
        if (inner.code === ')') break
        if (inner.code) out.push(inner)
      }
      continue
    }
    if (code.startsWith(`${directive} `)) out.push({ code: code.slice(directive.length + 1).trim(), comment })
  }
  return out
}

function goVersionAtLeast(v: string | undefined, major: number, minor: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(v ?? '')
  if (!m) return false
  const [maj, min] = [Number(m[1]), Number(m[2])]
  return maj > major || (maj === major && min >= minor)
}

// OSV's Go ranges carry versions without the `v` prefix.
function osvVersion(v: string): string {
  return v.startsWith('v') ? v.slice(1) : v
}

export function resolveGoMod(source: string, sourcePath: string): ServiceInventory | null {
  const goLine = /^\s*go\s+(\S+)/m.exec(source)?.[1]
  if (!/^\s*module\s+\S+/m.test(source)) return null

  const requirements: Requirement[] = []
  for (const { code, comment } of parseDirectiveLines(source, 'require')) {
    const m = /^(\S+)\s+(v\S+)$/.exec(code)
    if (m?.[1] && m[2]) requirements.push({ module: m[1], version: m[2], indirect: /\bindirect\b/.test(comment) })
  }

  // `old [v] => new v` substitutes a module version. `old [v] => ./path` is a local
  // replacement: first-party code, not a dependency.
  const replaced = new Map<string, { module: string; version: string } | 'local'>()
  for (const { code } of parseDirectiveLines(source, 'replace')) {
    const m = /^(\S+)(?:\s+(v\S+))?\s*=>\s*(\S+)(?:\s+(v\S+))?$/.exec(code)
    if (!m?.[1] || !m[3]) continue
    const key = m[2] ? `${m[1]}@${m[2]}` : m[1]
    replaced.set(key, m[4] ? { module: m[3], version: m[4] } : 'local')
  }

  const dependencies: ResolvedDependency[] = []
  for (const r of requirements) {
    const rep = replaced.get(`${r.module}@${r.version}`) ?? replaced.get(r.module)
    if (rep === 'local') continue
    const target = rep ?? { module: r.module, version: r.version }
    dependencies.push({
      ecosystem: 'Go',
      name: target.module,
      version: osvVersion(target.version),
      scope: r.indirect ? 'transitive' : 'direct',
      dev: false,
      introducedBy: [],
    })
  }
  return {
    source: sourcePath,
    resolution: goVersionAtLeast(goLine, 1, 17) ? 'complete' : 'partial',
    dependencies,
  }
}
