import { TreeFold, normalizePypiName, type ServiceInventory } from './resolved.js'

// Python lockfiles (dependency-inventory.md §3): poetry.lock and uv.lock resolve
// the whole tree; a requirements.txt resolves only what it pins exactly.

interface LockedPackage {
  name: string
  version: string
  // Normalized names of what this package depends on.
  deps: string[]
}

function walk(
  packages: Map<string, LockedPackage>,
  roots: Array<{ name: string; dev: boolean }>,
): TreeFold {
  const fold = new TreeFold('PyPI')
  for (const root of roots) {
    const queue: Array<{ name: string; isDirect: boolean }> = [{ name: root.name, isDirect: true }]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const { name, isDirect } = queue.shift()!
      if (seen.has(name)) continue
      seen.add(name)
      const pkg = packages.get(name)
      if (!pkg) continue
      fold.visit(pkg.name, pkg.version, { direct: root.name, dev: root.dev, isDirect })
      for (const d of pkg.deps) if (!seen.has(d)) queue.push({ name: d, isDirect: false })
    }
  }
  return fold
}

// Strip extras and markers from a dependency name: "requests[socks] ; python_version<'4'".
function bareName(spec: string): string {
  return normalizePypiName(spec.split(/[\s\[;<>=!~(]/, 1)[0] ?? spec)
}

// --- poetry.lock -----------------------------------------------------------

interface PoetryLock {
  package?: Array<{ name: string; version: string; dependencies?: Record<string, unknown> }>
}

export interface PoetryProject {
  tool?: {
    poetry?: {
      dependencies?: Record<string, unknown>
      'dev-dependencies'?: Record<string, unknown>
      group?: Record<string, { dependencies?: Record<string, unknown> }>
    }
  }
  project?: { dependencies?: string[]; 'optional-dependencies'?: Record<string, string[]> }
  'dependency-groups'?: Record<string, unknown[]>
}

export function resolvePoetryLock(lock: PoetryLock, lockPath: string, pyproject: PoetryProject): ServiceInventory {
  const packages = new Map<string, LockedPackage>()
  for (const p of lock.package ?? []) {
    const name = normalizePypiName(p.name)
    packages.set(name, { name, version: p.version, deps: Object.keys(p.dependencies ?? {}).map(normalizePypiName) })
  }
  const poetry = pyproject.tool?.poetry
  const prod = new Set<string>([
    ...Object.keys(poetry?.dependencies ?? {}),
    ...(pyproject.project?.dependencies ?? []),
  ].map(bareName))
  prod.delete('python')
  const dev = new Set<string>()
  for (const n of Object.keys(poetry?.['dev-dependencies'] ?? {})) dev.add(bareName(n))
  for (const g of Object.values(poetry?.group ?? {})) {
    for (const n of Object.keys(g.dependencies ?? {})) dev.add(bareName(n))
  }
  const roots = [
    ...[...prod].map((name) => ({ name, dev: false })),
    ...[...dev].filter((n) => !prod.has(n)).map((name) => ({ name, dev: true })),
  ]
  return { source: lockPath, resolution: 'complete', dependencies: walk(packages, roots).result() }
}

// --- uv.lock ---------------------------------------------------------------

interface UvLock {
  package?: Array<{
    name: string
    version?: string
    source?: Record<string, unknown>
    dependencies?: Array<{ name: string }>
    'optional-dependencies'?: Record<string, Array<{ name: string }>>
    'dev-dependencies'?: Record<string, Array<{ name: string }>>
  }>
}

/**
 * uv.lock lists the project itself as a package whose source is `editable` or
 * `virtual` at ".". Its dependencies are the direct ones, and its
 * dev-dependencies groups are dev. Returns null when the project entry isn't
 * there.
 */
export function resolveUvLock(lock: UvLock, lockPath: string, serviceName: string): ServiceInventory | null {
  const entries = lock.package ?? []
  const own = normalizePypiName(serviceName)
  const project =
    entries.find((p) => normalizePypiName(p.name) === own && (p.source?.editable !== undefined || p.source?.virtual !== undefined)) ??
    entries.find((p) => p.source?.editable === '.' || p.source?.virtual === '.')
  if (!project) return null
  const packages = new Map<string, LockedPackage>()
  for (const p of entries) {
    if (p === project || !p.version) continue
    const name = normalizePypiName(p.name)
    const deps = [
      ...(p.dependencies ?? []),
      ...Object.values(p['optional-dependencies'] ?? {}).flat(),
    ].map((d) => normalizePypiName(d.name))
    packages.set(name, { name, version: p.version, deps })
  }
  const prod = new Set((project.dependencies ?? []).map((d) => normalizePypiName(d.name)))
  const dev = new Set(Object.values(project['dev-dependencies'] ?? {}).flat().map((d) => normalizePypiName(d.name)))
  const roots = [
    ...[...prod].map((name) => ({ name, dev: false })),
    ...[...dev].filter((n) => !prod.has(n)).map((name) => ({ name, dev: true })),
  ]
  return { source: lockPath, resolution: 'complete', dependencies: walk(packages, roots).result() }
}

// --- requirements.txt ------------------------------------------------------

/**
 * Exact pins only (`name==1.2.3`). A file compiled by pip-compile records why a
 * pin is there in `# via` comments. A pin "via" other packages is transitive,
 * and one via `-r` / `-c` or nothing is direct. Without a lockfile the tree
 * isn't known, so the result is always `partial`.
 */
export function resolveRequirementsPins(content: string, sourcePath: string): ServiceInventory {
  const lines = content.split(/\r?\n/)
  const pins: Array<{ name: string; version: string; via: string[] }> = []
  let current: { name: string; version: string; via: string[] } | null = null
  let inVia = false
  for (const raw of lines) {
    const line = raw.trim()
    const pin = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([^\s;#\\]+)/.exec(line)
    if (pin && pin[1] && pin[2]) {
      const entry = { name: normalizePypiName(pin[1]), version: pin[2], via: [] as string[] }
      pins.push(entry)
      current = entry
      inVia = false
      const inline = /#\s*via\s+(.+)$/.exec(line)
      if (inline?.[1]) entry.via.push(...inline[1].split(',').map((s) => s.trim()))
      continue
    }
    if (!current || !line.startsWith('#')) {
      if (line && !line.startsWith('#')) current = null
      continue
    }
    const body = line.replace(/^#\s*/, '')
    if (/^via\b/.test(body)) {
      inVia = true
      const rest = body.replace(/^via\s*/, '')
      if (rest) current.via.push(rest)
    } else if (inVia && body) {
      current.via.push(body)
    }
  }
  const pinned = new Set(pins.map((p) => p.name))
  const parentsOf = new Map<string, string[]>()
  for (const p of pins) {
    parentsOf.set(
      p.name,
      p.via
        .filter((v) => !v.startsWith('-r') && !v.startsWith('-c') && !v.includes('.txt') && !v.includes('.in'))
        .map(bareName)
        .filter((n) => pinned.has(n) && n !== p.name),
    )
  }
  const isDirect = (name: string) => (parentsOf.get(name) ?? []).length === 0
  // `# via` names the immediate parents. introducedBy names the direct
  // dependencies at the top of those chains.
  const directAncestors = (name: string): string[] => {
    const out = new Set<string>()
    const seen = new Set<string>([name])
    const queue = [...(parentsOf.get(name) ?? [])]
    while (queue.length > 0) {
      const n = queue.shift()!
      if (seen.has(n)) continue
      seen.add(n)
      if (isDirect(n)) out.add(n)
      else queue.push(...(parentsOf.get(n) ?? []))
    }
    return [...out].sort()
  }
  const dependencies = pins.map((p) => {
    const direct = isDirect(p.name)
    return {
      ecosystem: 'PyPI' as const,
      name: p.name,
      version: p.version,
      scope: direct ? ('direct' as const) : ('transitive' as const),
      dev: false,
      introducedBy: direct ? [] : directAncestors(p.name),
    }
  })
  return { source: sourcePath, resolution: 'partial', dependencies }
}
