---
name: publish-system
description: Bin-wrapper subpath validity, version lockstep across six packages, tarball smoke-test gate with built-web + post-neatd liveness, dependency order, idempotency, npm immutability, engines field. Catches the 0.2.6 broken-publish and 0.3.0 broken-tarball failure shapes mechanically.
governs:
  - "packages/neat.is/bin/**"
  - "packages/neat.is/package.json"
  - "packages/core/package.json"
  - "packages/mcp/package.json"
  - "packages/types/package.json"
  - "packages/claude-skill/package.json"
  - "packages/web/package.json"
  - ".github/workflows/publish.yml"
  - "scripts/publish.sh"
adr: [ADR-052, ADR-064, ADR-059]
enforcement: [lint, review]
---

# Publish system contract

The npm publish pipeline. Six packages ship to the registry on every release; the system has been load-bearing since 0.2.5 but had no contract coverage, which is how the 0.2.6 broken-publish bug shipped and how the 0.3.0 broken-tarball followed. ADR-052 closed the first failure shape; ADR-064 closes the second.

## Six packages, dependency-ordered

```
@neat.is/types  →  @neat.is/core  →  @neat.is/mcp  →  @neat.is/claude-skill  →  @neat.is/web  →  neat.is
```

`@neat.is/web` joined the lockstep in ADR-059 (web UI bootstrap) — `npm install -g neat.is` pulls it in so `neatd start` can spawn the UI without the operator running a separate install. The umbrella has no code of its own — three bin wrappers in `packages/neat.is/bin/` that delegate to dist files in `core` and `mcp` via `require()`. That delegation is what `npm install -g neat.is` relies on to put `neat` / `neatd` / `neat-mcp` on PATH.

## Bin-wrapper subpath validity

Every `require('@scope/pkg/subpath')` in `packages/neat.is/bin/*` must resolve to a path exposed in the target package's `exports` field.

Today's wrappers (post-0.2.7):

| Wrapper | `require()` target | Must appear in |
|---|---|---|
| `bin/neat` | `@neat.is/core/dist/cli.cjs` | `core/package.json` exports |
| `bin/neatd` | `@neat.is/core/dist/neatd.cjs` | `core/package.json` exports |
| `bin/neat-mcp` | `@neat.is/mcp/dist/index.cjs` | `mcp/package.json` exports |

**Why this matters:** in monorepo dev, workspace symlinks bypass Node's `exports` enforcement, so a wrapper can `require()` any path inside a sibling package and it works. Tarball installs don't have that escape hatch — Node refuses any subpath not listed in `exports`. The 0.2.6 publish broke exactly here: wrappers worked locally, failed for everyone who ran `npm install -g neat.is`.

A contract test parses each wrapper file, extracts the require target via regex, splits into `@scope/pkg` + `subpath`, walks the target package.json's `exports`, and asserts the subpath is exposed. Literal-key match for MVP; wildcard patterns are successor work.

## Version lockstep

All six publishable packages carry the same `version` string in their `package.json` on `main`. Cross-package dep ranges in the packages that depend on others (`core` → `types`, `mcp` → `types`, `web` → `types`, `umbrella` → `core`/`mcp`/`claude-skill`/`web`) must match the same `X.Y.Z` exactly.

Half-bumped state on `main` is a contract violation. The CI workflow's "Verify versions are in lockstep" step blocks publish; a contract test on `main` blocks merge.

## Tarball smoke-test gate (ADR-064)

The publish workflow must verify the documented happy path against the just-published tarball before declaring success. "The bin entrypoint resolves" is necessary but not sufficient — the 0.3.0 publish passed that check and shipped a stack that couldn't serve `npm install -g neat.is && neatd start && open http://localhost:6328` on any fresh install.

The smoke step does four things, in order:

1. **Per-dep visibility wait.** Before installing the umbrella, the workflow waits for every package in the lockstep set (`@neat.is/{types,core,mcp,claude-skill,web}`, `neat.is`) to appear at the target version on the registry. The umbrella propagates faster than its deps in practice — the v0.3.1 smoke failed `ETARGET: No matching version found for @neat.is/web@^0.3.1` because the retry loop only checked the umbrella.

2. **Web artifact presence.** After `npm install neat.is@<version>`, the unpacked `node_modules/@neat.is/web/` must contain a built artifact at the bundling form #231 lands — `.next/standalone/packages/web/server.js` (Next 14 preserves the monorepo path under its auto-detected tracing root, so the runtime entry sits under `packages/web/`). Verified via `test -f`. Absence fails the workflow. Catches NEAT-BUG-1.

3. **Post-`neatd start` liveness.** The smoke step seeds `NEAT_HOME=$(mktemp -d)` with a fixture project registry, spawns `neatd start`, and within 30 seconds asserts:
   - `curl http://localhost:8080/graph` returns 200 (NEAT-BUG-2 / ADR-063).
   - `curl http://localhost:6328/` returns 200 (NEAT-BUG-1 / ADR-059).
   - `:4318` is bound by the daemon process (NEAT-BUG-2 OTLP side).

   The daemon is killed after the asserts.

4. **Fixture registry shape.** At least two projects, including one named `default` (so the ADR-026 unprefixed legacy paths resolve), and at least one whose project directory has a populated `node_modules/` (so `neatd`'s chokidar trigger exercises the polling fallback from NEAT-BUG-3 / #233).

Failure on any step exits non-zero. Per ADR-052 §6, npm immutability means the broken version stays on the registry — the operator has to bump and re-publish. The smoke gate is the last-chance check before users hit the bug.

## Dependency order

Publish proceeds in this order, never another:

```
types → core → mcp → claude-skill → web → neat.is
```

Out of order produces 404s — npm rejects publishes whose deps aren't on the registry yet. Encoded in both `.github/workflows/publish.yml` and `scripts/publish.sh`.

## Idempotency

Re-running the publish workflow after partial failure must skip packages already at the target version. Implementation: `npm view <pkg>@<version>` returns non-zero if the version isn't published; if it returns zero, skip. Re-runs after a 401 / network blip don't 409 on the packages that already landed.

## npm immutability

Once `name@version` is published, that slot is permanently sealed. `npm unpublish` does not free it for re-publish — the version number is reserved forever. Therefore:

- Publishing a broken version forces a patch-version bump (e.g. 0.2.6 broken → 0.2.7 fix).
- No tooling around `npm unpublish` recovery exists or should be built; npm policy makes the obvious recovery shape impossible.

Documented in `docs/runbook-publish.md`'s troubleshooting table.

## `engines.node: ">=20"`

Every publishable package and the umbrella. Older Node fails at install, not at runtime. The 20+ floor is what `chokidar@4`, modern `fastify@5`, and the rest of the dep tree assume.

## Authority

- **Bin wrappers**: `packages/neat.is/bin/{neat,neatd,neat-mcp}`
- **Package metadata**: each publishable `package.json`
- **CI publish**: `.github/workflows/publish.yml`
- **Local fallback**: `scripts/publish.sh`
- **Process docs**: `docs/runbook-publish.md`

## Enforcement

`describe` block in `contracts.test.ts`. Live assertions:

- **Subpath validity** — parses wrappers, walks exports, asserts every required subpath is exposed.
- **Version lockstep** — reads all six package.jsons, asserts versions match and cross-package dep ranges match the version.
- **`engines.node: ">=20"`** — every publishable package + umbrella has the field.
- **Dependency order** — the publish loop in `.github/workflows/publish.yml` and `scripts/publish.sh` references the six packages in `types → core → mcp → claude-skill → web → neat.is` order.
- **Smoke-test gate (umbrella `neat --help`)** — workflow installs the umbrella from the registry and runs `neat --help`.
- **Smoke-test gate (ADR-064 per-dep wait)** — workflow waits for every lockstep package's target version on the registry before installing.
- **Smoke-test gate (ADR-064 web artifact)** — workflow asserts presence of the built `@neat.is/web` artifact in the installed tree.
- **Smoke-test gate (ADR-064 post-`neatd` liveness)** — workflow spawns `neatd start` and asserts `:8080`, `:6328`, `:4318` reachable.
- **Smoke-test gate (ADR-064 fixture registry)** — workflow seeds a fixture with a `default` project and at least one nested-`node_modules` project.

Documented invariants without mechanized tests (policy, not code):

- npm immutability and the no-unpublish-recovery rule (rules 6, 7).
- Idempotency (rule 5) — exercised by every re-run; failure mode is a re-publish 409 which is loud enough.

Full rationale: [ADR-052](../decisions.md#adr-052--publish-system-contract), [ADR-064](../decisions.md#adr-064--tarball-smoke-test-verifies-built-web-artifact--post-neatd-start-liveness-amends-adr-052).
