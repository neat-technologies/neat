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
  - "server.json"
  - "packages/vscode/package.json"
  - ".github/workflows/publish-vscode.yml"
adr: [ADR-052, ADR-064, ADR-059, ADR-153, ADR-171]
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

## `packages/vscode` is outside the lockstep (ADR-171)

The VS Code / Open VSX editor extension lives at `packages/vscode` and is **not** one of the six version-locked packages. It is:

- **`private: true`** — never published to npm. The publish loop (`.github/workflows/publish.yml` + `scripts/publish.sh`) lists only the six; the `PUBLISHABLE_PACKAGES` set in `contracts.test.ts` names them literally, so the extension is excluded from the lockstep-version, cross-dep-range, `engines.node`, and dependency-order assertions by construction. Nothing to add there — the enumerated set is closed, not a `packages/*` glob.
- **esbuild-bundled, single CJS** — one `dist/extension.cjs` with `vscode` marked external, no ESM and no DTS. This is the documented exception to the "every package emits ESM + CJS + DTS via tsup" rule: nothing imports an extension, the editor host loads one CommonJS entry. It carries its own `version` line (starts `0.1.0`) with no relation to the npm train.
- **shipped on its own `vscode-v*` tag** — a dedicated workflow (`.github/workflows/publish-vscode.yml`) packages the `.vsix` once and pushes that one artifact to both Open VSX (`ovsx publish`) and the Marketplace (`vsce publish --packagePath`). Its own tag namespace keeps a marketplace hiccup from wedging npm and vice-versa. The job is gated on `OVSX_PAT` + `VSCE_PAT` secrets and a `vscode-v*` tag — until both exist it never runs, the same shape as the npm publish gate.

The `neat.is` umbrella does not depend on it; `npm install -g neat.is` has nothing to do with the extension.

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

## MCP Registry manifest (ADR-153)

`server.json` at the repo root is the manifest that lists NEAT's MCP server in the official MCP Registry under `io.github.neat-technologies/neat`. It rides the release, and it obeys the same lockstep discipline as the six packages:

- **Name matches the ownership marker.** `server.json`'s `name` equals the `mcpName` field in `packages/mcp/package.json`, and both start with `io.github.` (the GitHub-verifiable namespace form the OIDC publish authenticates). The registry proves package ownership by fetching the published `@neat.is/mcp` and matching `mcpName` against the server name — a mismatch fails the publish.
- **Version lockstep.** `server.json`'s `version` and its `packages[0].version` carry the same `X.Y.Z` as the six publishable packages. Bumping a release bumps `server.json` too; a half-bumped manifest on `main` is a contract violation, caught by the same test that guards package lockstep.
- **Additive publish, not a release gate.** The registry publish is a separate `mcp_registry` job in `publish.yml` that `needs: publish` and runs only on a real tag release, after the npm publish + smoke gate (the registry validates against the live package, so it must already be on npm). It authenticates with `mcp-publisher login github-oidc` and `publish`. A failure isolates to this job; it never unpublishes the npm / ghcr / Release trio, and the release does not depend on it.

## Repo-hosted plugin + marketplace (ADR-159)

The Claude Code plugin at `/plugin` and its marketplace manifest at `/.claude-plugin/marketplace.json` are a distributed artifact, but not an npm one. They ship straight from the GitHub repo — a user runs `claude plugin marketplace add NEAT-Technologies/Neat` then `claude plugin install neat@neat`, which reads the manifest and the `./plugin` source out of `main`. Nothing about the plugin is published to npm.

Consequences for the publish system:

- **Not in the six-package lockstep.** The plugin has no `package.json`, does not appear in the `types → core → mcp → claude-skill → web → neat.is` dependency order, and is not versioned in lockstep with the npm packages. It is not gated by the tarball smoke test. The publish workflow (`publish.yml` / `scripts/publish.sh`) is unchanged by it.
- **Version is independent and documented.** `plugin/.claude-plugin/plugin.json` carries its own `version` (0.7.1 at introduction), tracking the release train for coherence but not bound to the lockstep — the MCP server the plugin points at is pinned by npm (`npx -y @neat.is/mcp`), not by the plugin manifest. The plugin ships whenever `main` moves; there is no separate publish step to run.
- **Installability is validated, not published.** `claude plugin validate ./plugin` and `claude plugin validate ./.claude-plugin/marketplace.json` are the correctness checks (both pass `--strict`); a repackaging test (`packages/core/test/plugin-packaging.test.ts`) keeps the bundle's MCP config and hook matcher aligned with the à-la-carte surface.

If the plugin ever needs a tagged release independent of `main`, `claude plugin tag` cuts a `neat--v<version>` git tag after checking `plugin.json` and the marketplace entry agree — a future option, not part of the current release flow.

## Authority

- **Bin wrappers**: `packages/neat.is/bin/{neat,neatd,neat-mcp}`
- **Package metadata**: each publishable `package.json`
- **MCP Registry manifest**: `server.json` + the `mcpName` marker in `packages/mcp/package.json`
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
- **Registry manifest name ↔ marker (ADR-153)** — `server.json` `name` equals `packages/mcp/package.json` `mcpName`, and both start with `io.github.`.
- **Registry manifest lockstep (ADR-153)** — `server.json` `version` and `packages[0].version` match the six-package lockstep version, and `packages[0].identifier` is `@neat.is/mcp`.
- **Registry publish is additive + OIDC (ADR-153)** — `publish.yml` carries an `mcp_registry` job that `needs` the publish job and uses `mcp-publisher login github-oidc` + `publish`.

Documented invariants without mechanized tests (policy, not code):

- npm immutability and the no-unpublish-recovery rule (rules 6, 7).
- Idempotency (rule 5) — exercised by every re-run; failure mode is a re-publish 409 which is loud enough.

Full rationale: [ADR-052](../decisions.md#adr-052--publish-system-contract), [ADR-064](../decisions.md#adr-064--tarball-smoke-test-verifies-built-web-artifact--post-neatd-start-liveness-amends-adr-052).
