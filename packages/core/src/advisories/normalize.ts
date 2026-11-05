// Normalized advisories (advisory-cache.md §1). One shape for every source, so
// matching and the security card never read raw OSV.

export type SeverityLabel = 'critical' | 'high' | 'moderate' | 'low' | 'unknown'

export interface AffectedRange {
  type: 'SEMVER' | 'ECOSYSTEM' | 'GIT'
  events: Array<{ introduced?: string; fixed?: string; last_affected?: string; limit?: string }>
}

export interface AffectedPackage {
  ecosystem: string
  name: string
  ranges: AffectedRange[]
  versions?: string[]
  // Curated symbols where the source publishes them (vuln.go.dev).
  symbols?: string[]
}

export interface Advisory {
  id: string
  aliases: string[]
  summary: string
  details: string
  severity: { cvss?: string; label: SeverityLabel }
  cwe: string[]
  published?: string
  modified: string
  affected: AffectedPackage[]
  fixRefs: string[]
}

// The subset of an OSV record this reads. https://ossf.github.io/osv-schema/
export interface OsvRecord {
  id: string
  aliases?: string[]
  summary?: string
  details?: string
  modified: string
  published?: string
  severity?: Array<{ type: string; score: string }>
  database_specific?: { severity?: string; cwe_ids?: string[] }
  affected?: Array<{
    package?: { ecosystem?: string; name?: string }
    ranges?: Array<{ type: string; events: AffectedRange['events'] }>
    versions?: string[]
    ecosystem_specific?: { imports?: Array<{ path?: string; symbols?: string[] }> }
  }>
  references?: Array<{ type?: string; url?: string }>
}

function severityLabel(raw: string | undefined): SeverityLabel {
  switch ((raw ?? '').toLowerCase()) {
    case 'critical':
      return 'critical'
    case 'high':
      return 'high'
    case 'moderate':
    case 'medium':
      return 'moderate'
    case 'low':
      return 'low'
    default:
      return 'unknown'
  }
}

export function normalizeOsv(rec: OsvRecord): Advisory {
  const cvss = rec.severity?.find((s) => s.type.startsWith('CVSS'))?.score
  return {
    id: rec.id,
    aliases: [...(rec.aliases ?? [])].sort(),
    summary: rec.summary ?? '',
    details: rec.details ?? '',
    severity: { ...(cvss ? { cvss } : {}), label: severityLabel(rec.database_specific?.severity) },
    cwe: [...(rec.database_specific?.cwe_ids ?? [])].sort(),
    ...(rec.published ? { published: rec.published } : {}),
    modified: rec.modified,
    affected: (rec.affected ?? [])
      .filter((a) => a.package?.ecosystem && a.package?.name)
      .map((a) => {
        const symbols = (a.ecosystem_specific?.imports ?? []).flatMap((imp) =>
          (imp.symbols ?? []).map((s) => (imp.path ? `${imp.path}.${s}` : s)),
        )
        return {
          ecosystem: a.package!.ecosystem!,
          name: a.package!.name!,
          ranges: (a.ranges ?? [])
            .filter((r) => r.type === 'SEMVER' || r.type === 'ECOSYSTEM' || r.type === 'GIT')
            .map((r) => ({ type: r.type as AffectedRange['type'], events: r.events })),
          ...(a.versions && a.versions.length > 0 ? { versions: a.versions } : {}),
          ...(symbols.length > 0 ? { symbols } : {}),
        }
      }),
    fixRefs: (rec.references ?? []).filter((r) => r.type === 'FIX' && r.url).map((r) => r.url!),
  }
}

// Fold advisories that alias each other (a GHSA and a PYSEC for one issue) into
// one entry (advisory-cache.md §1). The canonical id is the GHSA when the group
// has one, otherwise the lowest id. The other ids go to `aliases`. Affected
// packages are merged, so a range only one record lists isn't lost.
export function foldAliases(advisories: Advisory[]): Advisory[] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)]
    if (ra !== rb) parent.set(ra, rb)
  }
  const byId = new Map(advisories.map((a) => [a.id, a]))
  for (const a of advisories) {
    if (!parent.has(a.id)) parent.set(a.id, a.id)
    // Only fold through ids we actually hold: a CVE alias shared by two records
    // joins them, but an alias alone never creates an entry.
    for (const alias of a.aliases) {
      if (!parent.has(alias)) parent.set(alias, alias)
      union(a.id, alias)
    }
  }
  const groups = new Map<string, Advisory[]>()
  for (const a of advisories) {
    const root = find(a.id)
    const g = groups.get(root) ?? []
    g.push(a)
    groups.set(root, g)
  }
  const out: Advisory[] = []
  for (const group of groups.values()) {
    const ids = group.map((a) => a.id).sort()
    const canonicalId = ids.find((id) => id.startsWith('GHSA-')) ?? ids[0]!
    const primary = byId.get(canonicalId)!
    const aliasSet = new Set<string>()
    for (const a of group) {
      for (const x of [a.id, ...a.aliases]) if (x !== canonicalId) aliasSet.add(x)
    }
    const affected: AffectedPackage[] = []
    const seen = new Set<string>()
    for (const a of [primary, ...group.filter((g) => g !== primary)]) {
      for (const p of a.affected) {
        const key = JSON.stringify(p)
        if (!seen.has(key)) {
          seen.add(key)
          affected.push(p)
        }
      }
    }
    const best = group.find((a) => a.severity.label !== 'unknown') ?? primary
    out.push({
      ...primary,
      aliases: [...aliasSet].sort(),
      severity: primary.severity.label !== 'unknown' ? primary.severity : best.severity,
      cwe: [...new Set(group.flatMap((a) => a.cwe))].sort(),
      affected,
      fixRefs: [...new Set(group.flatMap((a) => a.fixRefs))],
      modified: group.map((a) => a.modified).sort().at(-1)!,
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}
