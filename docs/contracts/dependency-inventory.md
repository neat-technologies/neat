---
name: dependency-inventory
description: Resolved third-party dependencies are graph nodes. One DependencyNode per resolved package version (ecosystem, name, version, purl), EXTRACTED from the lockfile; per-service facts (direct or transitive, dev, manifest locus, introducedBy) ride on a service→dependency DEPENDS_ON edge; first-party imports of a package are file→dependency IMPORTS edges carrying the specifier and bindings. Dependency code is extracted only for packages with an advisory match, and its symbols are owned by the DependencyNode, never by a first-party service.
governs:
  - "packages/core/src/extract/dependencies/**"
  - "packages/core/src/extract/dependency-symbols/**"
  - "packages/types/src/nodes.ts"
  - "packages/types/src/identity.ts"
adr: [ADR-274, ADR-028, ADR-030, ADR-032, ADR-158]
enforcement: [lint, review]
---

# Dependency inventory contract

A service runs third-party code, so the graph has to say which code. This contract defines how resolved dependencies enter the graph, and how a first-party file's use of one is recorded (ADR-274).

## 1. One node per resolved package version

`DependencyNode` is `{ id, type: 'DependencyNode', ecosystem, name, version, purl }`.

- `ecosystem` uses OSV's ecosystem names verbatim: `npm`, `PyPI`, `Go`, and later others. It's the key the advisory cache matches on (advisory-cache.md §3), so there's no translation step between the graph and the cache.
- `version` is the **resolved** version from a lockfile, or an exact pin. A declared range (`^4.17.0`) never becomes a node; guessing a version from a range would let NEAT report a CVE for code that isn't installed.
- `id` is `dep:<ecosystem>:<name>@<version>`, built by `dependencyId(ecosystem, name, version)` in `@neat.is/types/identity`. Hand-rolled ids are a violation (identity.md).
- Provenance is EXTRACTED. The node is shared across every service in the project that resolves the same version.

`ServiceNode.dependencies` (the declared name → range map) stays as it is. It's the declared view; the DependencyNode is the resolved view.

## 2. Per-service facts live on the edge

The same version can be a direct dependency of one service and a transitive one of another, so those facts belong to the relationship, not the node. Each service that resolves a version gets an EXTRACTED `DEPENDS_ON` edge `service → dependency` carrying:

- `scope: 'direct' | 'transitive'`
- `dev: boolean`: a dev-only dependency. It's kept on the graph, and the security card says so (security-card.md §4).
- `manifest: { file, line? }`: the lockfile entry that resolved it, or the manifest line for an exact pin. This is the edge's `evidence.file`, so ghost-edge cleanup keyed on `evidence.file` (static-extraction.md) retires it when the lockfile changes.
- `introducedBy: string[]`: for a transitive dependency, the names of the direct dependencies whose subtree pulls it in. It's the handle a fix needs ("bump express to pull a fixed qs").

## 3. Sources

The extractor reads, in priority order per service directory:

1. `package-lock.json` (v2 and v3), `pnpm-lock.yaml`, `yarn.lock`
2. `poetry.lock`, `uv.lock`, then `requirements.txt` exact pins (`==`)
3. `go.sum` together with `go.mod`

With no lockfile, only exact pins become nodes, and the service is marked `dependencyResolution: 'partial'` so a surface never presents an incomplete inventory as complete. Lockfiles are read and never written (init.md and sdk-install.md already forbid writing them).

## 4. First-party imports are edges

When a first-party file imports a package, extraction records an EXTRACTED `IMPORTS` edge `file → dependency`. Its evidence carries:

- `specifier`: the import string as written (`lodash`, `lodash/template`, `jinja2.filters`)
- `bindings`: the names bound locally (`{ template }`, `_`, `Template`)
- `line`

Test files are excluded under the existing test-scope precision filter (static-extraction.md). The edge is what makes a finding `imported` (security-card.md §2). It also lets the symbol-grain resolver (§5) turn a call on a binding into a call into the package.

## 5. Dependency code is extracted only where it matters

NEAT extracts a dependency's own source with the same symbol-grain producers it runs on first-party code (ADR-158), but only for dependency versions with at least one advisory match (advisory-cache.md §3). Extraction cost is bounded by the number of matched packages, never by the size of the lockfile.

- **Source.** The source is the installed copy when the project has one (`node_modules/<name>`, the active `site-packages/<name>`, the Go module cache). Otherwise it is the registry release fetched by the advisory cache (advisory-cache.md §4). Dependency code is read, never executed: no install scripts, no imports.
- **Ownership.** Dependency symbols are owned by the DependencyNode: `symbol:dep:<ecosystem>:<name>@<version>:<relPath>#<qualname>`, built by `dependencySymbolId(...)`. They never appear under a first-party service, so every first-party query (blast radius, divergences, incident cards) is unchanged by their presence.
- **Calls into the package.** First-party → package calls resolve through the IMPORTS bindings. A call on an imported binding (`template(...)`) or on an imported namespace (`_.template(...)`) becomes an EXTRACTED `CALLS` edge from the calling first-party symbol to the package's exported symbol. Package-internal CALLS edges come from the same producers.
- **What it cannot see.** A call that doesn't go through code isn't resolved: a template string invoking a filter, a dynamic `require`, reflection. The resolver records nothing in those cases, and the security card states the limit (security-card.md §2).

## 6. Authority

Mutation stays with `extract/*` (ADR-030). Lockfile parsing lives in `packages/core/src/extract/dependencies/`, and dependency symbol extraction in `packages/core/src/extract/dependency-symbols/`. Neither touches first-party nodes except to add the `DEPENDS_ON` and `IMPORTS` edges above.
