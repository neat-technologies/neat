import type { ResolvedDependency, ServiceInventory } from './resolved.js'

// go.mod (with go.sum) as a resolved inventory (dependency-inventory.md §3).
// Since Go 1.17 a module's go.mod lists every module its build needs. Direct
// requirements carry no comment, and the rest are marked `// indirect`. So for
// `go >= 1.17` the require list is the resolved build list, and go.sum only
// confirms it. Before 1.17 indirect requirements can be missing from go.mod, so
// go.sum completes the module/version set; without go.sum the inventory is
// `partial`.
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

// OSV's Go ranges carry versions without the `v` prefix and without the
// `+incompatible` build suffix Go attaches to pre-modules tags, so both come off
// here (every Go version, go.mod require lines and go.sum entries alike).
function osvVersion(v: string): string {
  const noV = v.startsWith('v') ? v.slice(1) : v
  return noV.replace(/\+incompatible$/, '')
}

// go.sum lines are `module version h1:...` and `module version/go.mod h1:...`.
// The module-version pairs are what matters; the `/go.mod` hash variant repeats
// a module already named by its bare line, so it's ignored. Versions are
// normalized the same way require versions are, and the set is deduped.
function parseGoSum(sum: string): Array<{ module: string; version: string }> {
  const seen = new Set<string>()
  const out: Array<{ module: string; version: string }> = []
  for (const line of sum.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const [module, rawVersion] = parts
    if (!module || !rawVersion || rawVersion.endsWith('/go.mod')) continue
    const version = osvVersion(rawVersion)
    const key = `${module}@${version}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ module, version })
  }
  return out
}

export function resolveGoMod(source: string, sourcePath: string, sum?: string | null): ServiceInventory | null {
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

  // Since Go 1.17 the require block is the complete build list, so go.sum only
  // confirms it. Before 1.17 indirect requirements can be missing, and go.sum is
  // the complete module/version set: the pairs it names that the require list
  // doesn't become transitive dependencies, which completes the inventory.
  const complete = goVersionAtLeast(goLine, 1, 17)
  let resolution: ServiceInventory['resolution'] = complete ? 'complete' : 'partial'
  if (!complete && sum) {
    const have = new Set(dependencies.map((d) => `${d.name}@${d.version}`))
    for (const { module, version } of parseGoSum(sum)) {
      const key = `${module}@${version}`
      if (have.has(key)) continue
      have.add(key)
      dependencies.push({
        ecosystem: 'Go',
        name: module,
        version,
        scope: 'transitive',
        dev: false,
        introducedBy: [],
      })
    }
    resolution = 'complete'
  }

  return { source: sourcePath, resolution, dependencies }
}
