---
name: advisory-cache
description: Advisories are shared public reference data, never tenant graph data. Normalized OSV records, folded by alias, held in a cache that a NEAT-hosted mirror serves and that falls back locally to OSV querybatch or the bulk export (opt-out NEAT_ADVISORIES=off). Matching an inventory against a cache snapshot is a pure, deterministic function. For each advisory the cache also holds NEAT's own fix-diff, the symbols that changed between the last affected and first fixed release, computed once and shared.
governs:
  - "packages/core/src/advisories/**"
adr: [ADR-274, ADR-158]
enforcement: [lint, review]
---

# Advisory cache contract

Known vulnerabilities are public facts about packages. NEAT stores them once and shares them, and keeps them out of any project's graph (ADR-274).

## 1. What a cached advisory holds

A normalized OSV record:

```
{
  id, aliases[], summary, details,
  severity: { cvss?: string, score?: number, label: 'critical'|'high'|'moderate'|'low'|'unknown' },
  cwe[], published, modified,
  affected: [{ ecosystem, name, ranges[], versions?: string[], symbols?: string[] }],
  fixRefs[],
  fixDiff?: { from, to, changed: [{ symbol, file, kind, namedInAdvisory }] }
}
```

- **Alias folding.** Records that alias each other (a GHSA and a PYSEC for the same issue) fold into one entry. The canonical id is the GHSA id when one exists, and the rest go to `aliases`. A surface never shows the same vulnerability twice.
- `affected[].symbols` carries curated symbols where the source publishes them (vuln.go.dev's `ecosystem_specific.imports[].symbols` for Go).
- `fixDiff` is NEAT's own derived data (§4).

## 2. Where it comes from

NEAT checks three sources in order. The engine must work with only the local fallbacks, so nothing waits on the hosted mirror existing:

1. **The NEAT-hosted mirror.** A shared mirror of the OSV bulk exports, refreshed on a cadence, queried by package. Using it keeps a project's dependency inventory from going to any third party. The URL is configurable, in the same shape as `NEAT_COMPAT_URL`.
2. **OSV `querybatch`** (`https://api.osv.dev/v1/querybatch`), then `/v1/vulns/{id}` for full records. This sends the inventory's package names and versions to osv.dev. `neat doctor` says so in one line whenever this path is active.
3. **The OSV bulk export** (`<ecosystem>/all.zip`), for offline or bench use.

`NEAT_ADVISORIES=off` disables all three. Surfaces then report "advisories disabled" rather than "no vulnerabilities".

The local cache lives under `~/.neat/advisories/`, keyed by ecosystem and package, with each entry stamped with when it was fetched. The default refresh is 24 hours. A failed refresh keeps serving the last good snapshot, and says how old it is.

## 3. Matching is pure

`matchAdvisories(inventory, snapshot) → Match[]` is a pure function: no I/O, no clock, no mutation. The same inventory and the same snapshot always give the same matches.

- npm and Go: `semver` over `SEMVER`-type ranges.
- PyPI: exact membership in `affected[].versions`. OSV PyPI ranges are `ECOSYSTEM`-type (PEP 440), which `semver` doesn't order correctly, and PyPI records enumerate the affected versions.
- Every match carries the snapshot's `asOf`, which reaches the security card.

## 4. The fix-diff

For each (advisory, package) with a known fixed version, NEAT works out what the fix changed:

1. `to` is the first fixed version. `from` is the release immediately before it in the registry's version list, inside the affected range.
2. Fetch both releases from the registry (npm tarball, PyPI sdist, Go module zip). They are read and never executed.
3. Run NEAT's symbol-grain producers (ADR-158) over both.
4. A symbol is in `changed` when its own tokens differ (excluding nested symbols, comments, docstrings and type annotations), or when it's new in `to`. Class-kind symbols are excluded; their methods carry the change.
5. `namedInAdvisory` is true when the symbol's name appears in the advisory's summary or details. It is a ranking hint only, never a filter.

The fix-diff is computed once per (advisory, package, from, to) and shared through the cache like the advisory itself. It is deterministic: the same two releases always give the same set.

- **Several advisories in one release.** When one release fixes several advisories, they share a changed set. Each advisory's card then says "changed in the fix release", never "the vulnerable function".
- **No fix-diff.** With no fixed version, or a release that can't be extracted, the advisory has no fixDiff, and findings fall back to package grain (security-card.md §3).
- **Curated symbols.** Where they exist (Go), they are used as-is. The fix-diff is computed alongside them as a cross-check.

## 5. Never in a tenant graph

Advisory bodies and fix-diffs never enter a project's graph or snapshot. A project's graph holds its DependencyNodes (dependency-inventory.md), and a security card references an advisory by id and `asOf`. A hosted tenant reads the shared mirror; it doesn't hold its own copy.
