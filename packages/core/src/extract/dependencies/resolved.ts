// One resolved dependency of one service, before it becomes graph state
// (dependency-inventory.md §1–2). Parsers produce these; index.ts turns them into
// a DependencyNode plus the service's DEPENDS_ON edge.
export interface ResolvedDependency {
  ecosystem: 'npm' | 'PyPI'
  name: string
  version: string
  scope: 'direct' | 'transitive'
  dev: boolean
  // Direct dependency names whose subtree pulls this one in. Empty when direct.
  introducedBy: string[]
}

export interface ServiceInventory {
  // Absolute path of the lockfile or manifest that resolved the inventory.
  source: string
  resolution: 'complete' | 'partial'
  dependencies: ResolvedDependency[]
}

// Walks a resolved dependency tree from a service's direct dependencies and
// folds every path into one record per (name, version). A version is `dev` only
// when every path to it starts at a dev dependency, and `introducedBy` collects
// the direct dependencies whose subtree reaches it.
export class TreeFold {
  private readonly byKey = new Map<string, ResolvedDependency & { prodPath: boolean }>()

  constructor(private readonly ecosystem: ResolvedDependency['ecosystem']) {}

  visit(name: string, version: string, via: { direct: string; dev: boolean; isDirect: boolean }): boolean {
    const key = `${name}@${version}`
    const cur = this.byKey.get(key)
    if (!cur) {
      this.byKey.set(key, {
        ecosystem: this.ecosystem,
        name,
        version,
        scope: via.isDirect ? 'direct' : 'transitive',
        dev: via.dev,
        introducedBy: via.isDirect ? [] : [via.direct],
        prodPath: !via.dev,
      })
      return true
    }
    let changed = false
    if (via.isDirect && cur.scope !== 'direct') {
      cur.scope = 'direct'
      changed = true
    }
    if (!via.isDirect && !cur.introducedBy.includes(via.direct)) {
      cur.introducedBy.push(via.direct)
      changed = true
    }
    if (!via.dev && !cur.prodPath) {
      cur.prodPath = true
      cur.dev = false
      changed = true
    }
    return changed
  }

  // A locked package no walk reached (an unrecorded peer). Kept as transitive
  // with no known introducer, and treated as production, the conservative
  // reading. Never overrides a version a walk already reached.
  visitUnattributed(name: string, version: string): void {
    const key = `${name}@${version}`
    if (this.byKey.has(key)) return
    this.byKey.set(key, {
      ecosystem: this.ecosystem,
      name,
      version,
      scope: 'transitive',
      dev: false,
      introducedBy: [],
      prodPath: true,
    })
  }

  result(): ResolvedDependency[] {
    return [...this.byKey.values()]
      .map(({ prodPath: _p, ...d }) => ({
        ...d,
        // A direct dependency is introduced by nothing, even if another direct
        // dependency also pulls it in.
        introducedBy: d.scope === 'direct' ? [] : [...d.introducedBy].sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  }
}

// PEP 503 name normalization. OSV keys PyPI advisories by the normalized name,
// so the node's name is normalized too, and `Jinja2`, `jinja2` and `jinja_2`
// can't become three nodes.
export function normalizePypiName(name: string): string {
  return name.replace(/[-_.]+/g, '-').toLowerCase()
}

export function purlFor(ecosystem: ResolvedDependency['ecosystem'], name: string, version: string): string {
  if (ecosystem === 'npm') {
    const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name
    return `pkg:npm/${encoded}@${version}`
  }
  return `pkg:pypi/${name}@${version}`
}
