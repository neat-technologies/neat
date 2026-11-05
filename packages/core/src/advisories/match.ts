import semver from 'semver'
import type { Advisory, AffectedPackage, AffectedRange } from './normalize.js'

// Matching an inventory against an advisory snapshot (advisory-cache.md §3). A
// pure function: no I/O, no clock, no mutation. The same inventory and the same
// snapshot always give the same matches.

export interface InventoryItem {
  // The DependencyNode id this item came from.
  dependencyId: string
  ecosystem: string
  name: string
  version: string
}

export interface AdvisorySnapshot {
  asOf: string
  advisories: Advisory[]
}

export interface AdvisoryMatch {
  advisoryId: string
  dependencyId: string
  // Versions the advisory says fix this package, lowest first. Empty when no
  // fix is released.
  fixedIn: string[]
  asOf: string
}

// PyPI names are compared PEP 503-normalized (the inventory already is); npm and
// Go names are case-sensitive.
function sameName(ecosystem: string, a: string, b: string): boolean {
  if (ecosystem === 'PyPI') return a.replace(/[-_.]+/g, '-').toLowerCase() === b.replace(/[-_.]+/g, '-').toLowerCase()
  return a === b
}

function parse(v: string): semver.SemVer | null {
  return semver.parse(v.startsWith('v') ? v.slice(1) : v)
}

// One SEMVER range, evaluated the way the OSV schema defines it: walk the events
// in version order. `introduced` opens an affected span, `fixed` closes it
// before that version, and `last_affected` closes it after that version.
function inSemverRange(version: semver.SemVer, range: AffectedRange): boolean {
  const events = range.events
    .map((e) => {
      const [kind, raw] = Object.entries(e)[0] ?? []
      if (!kind || raw === undefined) return null
      const at = raw === '0' ? null : parse(raw)
      if (raw !== '0' && !at) return null
      return { kind, at }
    })
    .filter((e): e is { kind: string; at: semver.SemVer | null } => e !== null)
    .sort((a, b) => (a.at === null ? -1 : b.at === null ? 1 : semver.compare(a.at, b.at)))

  let affected = false
  for (const e of events) {
    const cmp = e.at === null ? 1 : semver.compare(version, e.at)
    if (e.kind === 'introduced' && cmp >= 0) affected = true
    else if (e.kind === 'fixed' && cmp >= 0) affected = false
    else if (e.kind === 'last_affected' && cmp > 0) affected = false
    else if (e.kind === 'limit' && cmp >= 0) affected = false
  }
  return affected
}

function packageAffects(pkg: AffectedPackage, ecosystem: string, version: string): boolean {
  // An explicit version list is authoritative wherever it's given. PyPI's ranges
  // are PEP 440 (ECOSYSTEM type), which semver doesn't order correctly, and PyPI
  // records enumerate their versions, so PyPI matches by membership only.
  if (pkg.versions && pkg.versions.includes(version)) return true
  if (ecosystem === 'PyPI') return false
  const v = parse(version)
  if (!v) return false
  return pkg.ranges.some((r) => (r.type === 'SEMVER' || (r.type === 'ECOSYSTEM' && ecosystem !== 'PyPI')) && inSemverRange(v, r))
}

function fixedVersions(pkg: AffectedPackage): string[] {
  const out = new Set<string>()
  for (const r of pkg.ranges) for (const e of r.events) if (e.fixed) out.add(e.fixed)
  return [...out].sort((a, b) => {
    const [pa, pb] = [parse(a), parse(b)]
    return pa && pb ? semver.compare(pa, pb) : a.localeCompare(b)
  })
}

export function matchAdvisories(inventory: InventoryItem[], snapshot: AdvisorySnapshot): AdvisoryMatch[] {
  const out: AdvisoryMatch[] = []
  for (const item of inventory) {
    for (const adv of snapshot.advisories) {
      const hits = adv.affected.filter(
        (p) => p.ecosystem === item.ecosystem && sameName(item.ecosystem, p.name, item.name),
      )
      const affecting = hits.filter((p) => packageAffects(p, item.ecosystem, item.version))
      if (affecting.length === 0) continue
      out.push({
        advisoryId: adv.id,
        dependencyId: item.dependencyId,
        fixedIn: [...new Set(affecting.flatMap(fixedVersions))],
        asOf: snapshot.asOf,
      })
    }
  }
  return out.sort((a, b) => a.dependencyId.localeCompare(b.dependencyId) || a.advisoryId.localeCompare(b.advisoryId))
}
