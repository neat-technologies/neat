---
name: sdk-install
description: Per-language installer modules. Plan/apply decoupled. Manifests touched, lockfiles never. Idempotent. Composable with init. Node apply phase writes generated otel-init + injects entry-point require/import + per-package .env.neat with OTEL_SERVICE_NAME.
governs:
  - "packages/core/src/installers/**"
  - "packages/core/src/cli.ts"
adr: [ADR-047, ADR-046, ADR-027, ADR-069, ADR-070]
---

# SDK install contract

The second of four v0.2.5 distribution-layer contracts. Sibling contracts: [`init.md`](./init.md), [`project-registry.md`](./project-registry.md), [`daemon.md`](./daemon.md). ADR-069 extends the Node apply surface to write generated SDK setup, inject entry-point imports, and configure per-package service naming (v0.3.6). ADR-070 extends entry detection to `src/`-layout services and scripts-declared entries (v0.3.6).

NEAT's MVP success criterion (ADR-027) requires runtime telemetry. Pre-v1, NEAT installs the OTel SDK across the user's codebase via `neat init`. eBPF and service-mesh capture out of MVP.

## Installer module interface

```ts
{
  language: 'javascript' | 'python' | ...,
  detect(serviceDir): boolean,
  plan(serviceDir): InstallPlan,
  apply(serviceDir, plan): ApplyResult,
}
```

`plan` and `apply` decoupled — patch can be saved, reviewed, re-applied later.

## Two languages in MVP

| Language | Manifest edits | Generated files | Entrypoint edits | Service-name config |
|----------|----------------|-----------------|------------------|---------------------|
| Node | `@opentelemetry/api`, `sdk-node`, `auto-instrumentations-node`, `dotenv` → `package.json` deps (ADR-069 §5) | `otel-init.{js,ts}` adjacent to resolved entry, loads `.env.neat` via `dotenv`, registers `@opentelemetry/auto-instrumentations-node/register` (ADR-069 §1) | First non-shebang line of resolved entry becomes `require('./otel-init.js')` or `import './otel-init.js'` (ADR-069 §3) | `<package-dir>/.env.neat` carrying `OTEL_SERVICE_NAME=<pkg.name>` (scope-preserved) + `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (ADR-069 §4) |
| Python | `opentelemetry-distro`, `opentelemetry-exporter-otlp` → `requirements.txt` or `pyproject.toml` | — (deferred to a successor ADR) | entrypoint prefixed with `opentelemetry-instrument` | `OTEL_EXPORTER_OTLP_ENDPOINT` set in orchestration layer |

**Java, Ruby, .NET, Go, Rust** — out of MVP. Each requires a successor ADR. Python apply-side parity with the Node generated-file pattern lives behind a future ADR.

## Node entry-point resolution (ADR-069 §2 + ADR-070)

The Node installer resolves a service's entry point in this order:

1. **`pkg.main`** — when present **and the file exists on disk**. A `main` pointing at a missing build output (e.g. `dist/index.js` pre-build) falls through to the next step rather than marking the package lib-only (ADR-070).
2. **`pkg.bin[<pkg.name>]`** — when `pkg.bin` is a string, treat as the entry; when `pkg.bin` is a map, prefer the entry keyed on the package name. Resolved when the path exists.
3. **Entry parsed from `pkg.scripts.start`** (ADR-070) — tokenise the script, skip recognised launchers (`node`, `ts-node`, `tsx`, `ts-node-dev`, `nodemon`, `npx`, `pnpm`, `yarn`, `npm`, `cross-env`, `dotenv`, `--`) and flag tokens (start with `-`) and env-var assignments (`FOO=bar`), then return the first remaining token that names a file inside the package. Chained shells (`a && b`) or pipes cause the tokeniser to bail and the heuristic falls through.
4. **Entry parsed from `pkg.scripts.dev`** (ADR-070) — same tokeniser. Captures `tsx watch src/index.ts`, `ts-node-dev src/server.ts`, etc.
5. **`src/index.{ts,tsx,js,mjs,cjs}`** (ADR-070) — first match, in that extension order.
6. **`src/server.{...}` / `src/main.{...}` / `src/app.{...}`** (ADR-070) — each pattern probed in turn, same extension order. Covers conventional Node web-service layouts.
7. **`index.{ts,tsx,js,mjs,cjs}`** at the package root — the original ADR-069 §3 fallback.

Packages with no resolvable entry across all seven steps are **lib-only** and skipped. The apply summary logs each skip with reason `lib-only` so the user can see coverage.

## ESM/CJS + TS/JS dispatch (ADR-069 §1, §3)

- **ESM** when `pkg.type === 'module'` OR the entry extension is `.mjs`/`.ts`/`.tsx`. Inserted line is `import './otel-init.js'` (or extensionless form for TS).
- **CJS** otherwise. Inserted line is `require('./otel-init.js')`.
- **TS template** when the entry ends in `.ts`/`.tsx`. The generated `otel-init.ts` compiles through whatever TS pipeline the host package already uses.

The relative path is computed against the entry's directory so the injection works regardless of the entry's depth inside the package.

## Per-service `OTEL_SERVICE_NAME` (ADR-069 §4)

`.env.neat` lives at the package root and carries `OTEL_SERVICE_NAME=<pkg.name>`. Scoped names (`@medusajs/auth`) are preserved verbatim — the scope matches the EXTRACTED ServiceNode id format (ADR-028 + `extract/services.ts`), so dashboards joining OBSERVED spans against the graph use the same key on both sides. NEAT does not strip scopes.

The generated `otel-init` file loads `.env.neat` via `dotenv` so the service name is in scope before the auto-instrumentation hook runs. This is why `dotenv` joins the Node dependency list as the fourth package.

## Patch shape

```ts
InstallPlan = {
  language: string,
  dependencyEdits: Array<{ file, kind: 'add'|'remove', name, version }>,
  entrypointEdits: Array<{ file, before, after }>,
  envEdits: Array<{ file, key, value }>,
  generatedFiles?: Array<{ file, contents }>,  // ADR-069 §1
}
```

The plan is what `init` writes to `neat.patch`. The dry-run rendering names every file the apply phase would write, with the exact lines that would land — diff-shaped, reviewable byte-for-byte (ADR-069 §8).

## Lockfiles never touched

Installers update **manifests** only. After `--apply`, init prints `Run "npm install"` so user owns the lockfile commit. NEAT does not run `npm install` itself.

## Allowed write paths (ADR-069 §7)

The Node installer's apply phase may write only to:

- `<package-dir>/package.json` — dependency additions, no version bumps on existing entries.
- `<package-dir>/otel-init.{js,ts}` — generated SDK setup.
- `<package-dir>/.env.neat` — `OTEL_SERVICE_NAME` + `OTEL_EXPORTER_OTLP_ENDPOINT`.

Any other write from an installer module is a contract violation. The lockfile list from `installers/index.ts` (`FORBIDDEN_LOCKFILES`) remains the regression scan.

## Idempotency

`plan(dir)` returns empty plan when the SDK is already installed end-to-end. Re-running `init --apply` produces no diff. No version-bump churn.

Per-write idempotency (ADR-069 §6):

- `otel-init.{js,ts}` already adjacent to the entry → log `already instrumented`, skip the file write **and** the entry-point injection.
- Entry's first non-shebang line already matches the injection pattern → skip the injection (covers cases where the user pre-instrumented).
- `.env.neat` already present → preserve it; never overwrite.
- Dep already in `package.json` at any version → no-op.

## Patch is deterministic

Same input → same patch. Reviewable byte-for-byte across runs.

## Apply failure is recoverable

Partial success → emits `neat-rollback.patch`. NEAT does not silently leave broken state.

## Apply summary (ADR-069 §9)

The apply phase returns a per-package summary the CLI logs at the end of `neat init --apply`:

```
instrumented N, already-instrumented M, lib-only K
```

The structured shape lives in `installers/shared.ts` so successor language installers return the same.

## Composability

- `neat init --no-install` — graph + registry without SDK install.
- `neat install <path>` — alias for `init --skip-discovery --skip-registry`.

## Authority

`packages/core/src/installers/`. One file per language. Common patch-application in `installers/shared.ts`. Generated-file templates for the Node installer live in `installers/templates/` (or as inline constants in `javascript.ts` — the location is implementation, not contract; ADR-069 #1).

## Enforcement

Existing `describe('SDK install contract (ADR-047)')` block in `packages/core/test/audits/contracts.test.ts`. New `describe('SDK install — apply-side (ADR-069)')` block covers entry resolution, ESM/CJS/TS dispatch, generated-file content, entry-point injection (shebang-aware), `.env.neat` shape, four-deps invariant, idempotency on a second `--apply`, lib-only-skip, allowed write-path restriction, and dry-run/apply path parity. `it.todo` entries flip live as the v0.3.6 implementation lands.

Full rationale: [ADR-047](../decisions.md#adr-047--sdk-install-contract) (interface + plan/apply split) and [ADR-069](../decisions.md#adr-069--neat-init---apply-produces-executable-changes) (apply-side specifics).
