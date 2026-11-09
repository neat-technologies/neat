---
name: security-card
description: The security card is the work order for one vulnerability in one service, parallel to the incident card. One card per (advisory, dependency version, service), composed purely from the graph and an advisory snapshot. Reachability is a four-step ladder (present, imported, reachable-static, reachable-observed), each step with its evidence and provenance. Grain is the finest the evidence supports (symbol from the fix-diff or curated data, else package). Findings rank by exposure, then severity, then direct before transitive; present is context, never a finding. Observed coverage is stated on every card.
governs:
  - "packages/core/src/security-card.ts"
  - "packages/types/src/security-card.ts"
adr: [ADR-274, ADR-221, ADR-158, ADR-029]
enforcement: [lint, review]
---

# Security-card contract

The incident card says "this broke, here is where and why". The security card says "this known vulnerability is in your service, here is whether your code reaches it and whether it ran" (ADR-274). It is a work order for an agent, ranked by exposure rather than by lockfile presence.

## 1. Pure composition

`buildSecurityCard(graph, match, snapshot)` in `security-card.ts` is a pure function over the graph, one advisory match (advisory-cache.md §3) and the advisory snapshot: no I/O, no mutation, no clock. It reads the DependencyNode, its `DEPENDS_ON` and `IMPORTS` edges, CALLS edges into and inside the dependency, and OBSERVED evidence. It computes reachability (§2) and nothing else. No LLM call takes part in composing, ranking or gating a card. A model may reason over a card; it never produces one.

## 2. The reachability ladder

Each card has exactly one `level`, the highest step its evidence supports:

| Level | Evidence | Provenance |
|---|---|---|
| `present` | The service resolves the vulnerable version (a `DEPENDS_ON` edge) | EXTRACTED |
| `imported` | At least one non-test first-party file imports the package (`IMPORTS` edge) | EXTRACTED |
| `reachable-static` | An EXTRACTED CALLS path from a first-party symbol, into the package's exported symbol, through package-internal CALLS, to a symbol in the advisory's changed set (fix-diff or curated) | EXTRACTED |
| `reachable-observed` | Runtime evidence that the package's own code executed (§2a) | OBSERVED |

**2a. What counts as observed.** Two sources, both deterministic:
- an OTel instrumentation scope that names the package (otel-ingest.md keeps the scope name and version);
- a recorded exception stack frame inside the package's installed path (`node_modules/<name>/`, `site-packages/<name>/`).

A frame that lands on a changed-set symbol is recorded as such; it's the strongest evidence a card can carry.

**"The importing file ran" never promotes a card to `reachable-observed`.** An OBSERVED edge from a first-party symbol that imports the package goes in `supporting` as `importer-observed`, and that is all it does. It shows the importer executed, not the package.

**Limits stated on the card.** `method` is `'call-graph, no dataflow'`. NEAT does not claim that untrusted input reaches the symbol. A call that doesn't go through code (a template string invoking a filter, a dynamic `require`, reflection) isn't resolved. When an import exists but no path is found, the card stays at `imported`, and `limits` names the reason where one is known.

## 3. Grain

`grain` is the finest the evidence supports: `'symbol' | 'file' | 'package'`. `grainSource` records where it came from:
- `'fix-diff'`: NEAT's diff of the fix release (advisory-cache.md §4)
- `'curated'`: symbols published with the advisory (Go)
- `'package'`: neither was available

`changedInFix` lists the changed symbols with `namedInAdvisory`. When one release fixes several advisories, the card says "changed in the fix release" and never names a single symbol as "the vulnerable function".

## 4. Shape

`SecurityCardSchema` lives in `@neat.is/types` next to `IncidentCardSchema`:

```
{
  kind: 'security',
  id,                 // sec:<advisoryId>:<dependencyId>:<serviceId>
  service,
  advisory:   { id, aliases[], summary, severity, cwe[], published, modified, asOf },
  dependency: { id, ecosystem, name, version, scope, dev, introducedBy[], manifest: { file, line? } },
  fix:        { fixedIn: string[] | null },
  reachability: {
    level, grain, grainSource,
    changedInFix: [{ symbol, file, namedInAdvisory }],
    importers:    [{ file, symbol?, line, provenance: 'EXTRACTED' }],
    path:         [{ from, to, provenance }] | null,
    observed:     [{ source: 'instrumentation-scope' | 'stack-frame', locus?, at, provenance: 'OBSERVED' }],
    supporting:   [{ kind: 'importer-observed', symbol, at }],
    method: 'call-graph, no dataflow',
    limits: string[],
  },
  coverage: { instrumented: 'yes' | 'no' | 'unknown' },
  headline,
}
```

Every claim on the card carries its provenance.
- `coverage.instrumented` is per service. When it isn't `'yes'`, the absence of `reachable-observed` is never presented as "not running". The headline says the service isn't instrumented.
- `dev: true` is shown on the card. A dev-only dependency is context unless it is `reachable-observed`.

## 5. Ranking

A list surface orders cards by:
1. `level`: `reachable-observed` > `reachable-static` > `imported`. `present` cards are context and are never ranked as findings.
2. then `advisory.severity`;
3. then `scope`: direct before transitive.

## 6. Surfaces

The MCP and REST surfaces that return cards (`get_cves`, `get_reachable_cves`, `is_reachable`, `scan_diff`, with REST parity) return this shape. Their names and parameters are set by the surface PR under mcp-tools.md and rest-api.md, against this card.
