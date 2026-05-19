---
name: framework-installers
description: The JS SDK installer extends the framework dispatch pattern v0.3.8 introduced for Next.js to Remix, SvelteKit, Nuxt, and Astro. Each framework adds one detection signal, one `plan<Framework>` function, and one new entry in `plan()`'s dispatch chain. Detection precedence is Next → Remix → SvelteKit → Nuxt → Astro → vanilla Node. Amends — does not supersede — `sdk-install.md`.
governs:
  - "packages/core/src/installers/javascript.ts"
adr: [ADR-074, ADR-073, ADR-047, ADR-069, ADR-070]
---

# Framework installer paths contract

Amends [`sdk-install.md`](./sdk-install.md) for the four meta-frameworks beyond Next.js. The four-deps invariant, the lockfiles-never rule, the plan/apply decoupling, and the `.env.neat` `OTEL_SERVICE_NAME` shape from ADR-047 / ADR-069 all hold for every framework branch. Each branch adds one `plan<Framework>` function and one detection-chain entry in `plan()`.

Six sections, one rule each.

## 1. Detection precedence in `plan()` is Next → Remix → SvelteKit → Nuxt → Astro → vanilla Node

When a package declares multiple frameworks (e.g. a Remix app vendored under a Next monorepo, or a SvelteKit app importing an Astro-built widget), the deepest framework that owns the boot path wins. The ordering encodes which framework is most likely to be the actual runtime host for the package the installer is examining.

The chain bails on the first match — `plan()` returns the framework-specific plan without falling through to the vanilla Node entry-point injection. The chain runs over a single package at a time; a monorepo with five different framework choices produces five different plans, one per package.

## 2. Remix dispatch

**Detection signal:**

- `package.json` dependency includes `remix` or any `@remix-run/*` package (e.g. `@remix-run/node`, `@remix-run/serve`, `@remix-run/express`).
- A file at `app/entry.server.{ts,tsx,js,jsx}` (or `src/entry.server.*` for projects using the src-dir layout).

**Apply surface:**

- Write `app/otel.server.{ts,js}` (TypeScript / JavaScript matching the project's `tsconfig.json` presence) — the OTel init module that boots `@opentelemetry/sdk-node`.
- Inject a top-of-module import into the existing `entry.server.{ts,tsx,js,jsx}`: `import './otel.server'` (TS) or `require('./otel.server')` (CJS-flavored JS). Idempotent — re-running detects the existing import and no-ops.
- Write `.env.neat` at the package root with the standard `OTEL_SERVICE_NAME` + endpoint default (per ADR-047 §3).
- Records `framework: 'remix'` on the install plan.

**Why this shape:** Remix's `entry.server` is the documented module-load top for server-side customisation. The OTel init runs before any Remix handler imports run.

## 3. SvelteKit dispatch

**Detection signal:**

- `package.json` dependency includes `@sveltejs/kit`.
- A file at `src/hooks.server.{ts,js}` (the SvelteKit-canonical server hooks file). If the file is absent and `svelte.config.{js,ts}` is present at the root, apply creates the file with the standard handle export plus the OTel import.

**Apply surface:**

- Emit `src/otel-init.{ts,js}` at the SvelteKit src-dir root — the OTel init module.
- Extend `src/hooks.server.{ts,js}` with a top-level `import './otel-init'` (or create the file if absent). Idempotent on re-run.
- Write `.env.neat` at the package root.
- Records `framework: 'sveltekit'` on the install plan.

**Why this shape:** `hooks.server` runs once per server process at module-load time, before any route handler executes. SvelteKit handles the import as part of its own bundling pass without needing a config edit.

## 4. Nuxt dispatch

**Detection signal:**

- `package.json` dependency includes `nuxt`.
- A file at `nuxt.config.{ts,js,mjs}` at the package root.

**Apply surface:**

- Write `server/plugins/otel.{ts,js}` — Nuxt picks up files under `server/plugins/` via convention, no config edit required.
- The plugin imports `./otel-init` (emitted as `server/plugins/otel-init.{ts,js}`) which boots the SDK.
- Write `.env.neat` at the package root.
- Records `framework: 'nuxt'` on the install plan.

**Why this shape:** Nuxt's `server/plugins/` directory is the convention-driven extension point for server-side plugins. The plugin runs at server startup before any Nitro handler.

## 5. Astro dispatch

**Detection signal:**

- `package.json` dependency includes `astro`.
- A file at `astro.config.{mjs,ts,js}` at the package root.

**Apply surface:**

- Write `src/middleware.{ts,js}` (the Astro-canonical middleware file) — Astro runs middleware on every request, and the top-of-module import boots the OTel SDK once.
- If `src/middleware.*` already exists, inject a top-of-module `import './otel-init'` (idempotent on re-run); otherwise create the file with the standard onRequest export plus the OTel import.
- Emit `src/otel-init.{ts,js}` alongside the middleware.
- Write `.env.neat` at the package root.
- Records `framework: 'astro'` on the install plan.

**Why this shape:** Astro middleware is the documented per-request hook; module-load runs once before the first request and is the right place for SDK initialisation.

## 6. The four-deps invariant holds for every framework branch

Every framework branch adds the same four OTel dependencies the plain Node path adds (per ADR-047 §1 and ADR-069 §5):

- `@opentelemetry/sdk-node`
- `@opentelemetry/auto-instrumentations-node`
- `@opentelemetry/exporter-trace-otlp-http`
- `@opentelemetry/api`

No framework branch swaps in a framework-specific OTel package — the auto-instrumentation set already covers HTTP / fetch / DB-driver tracing for every framework named here. Versions are pinned in `installers/javascript.ts`'s `SDK_PACKAGES` constant; framework branches read the same constant.

Lockfiles remain untouched (per [`sdk-install.md`](./sdk-install.md) — `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` are operator territory; `neat init --apply` writes manifest edits only). Manifest edits use the four-deps `add` shape; existing deps are skipped on idempotency.

The entry-point injection path (`pkg.main` / `bin` / `scripts.start` / `src/…`) from ADR-069 §2 + ADR-070 is skipped for every framework branch — the framework owns the boot path, and a `require('./otel-init')` injection into `pkg.main` would be ignored (or worse, re-run after the framework's hook). The framework's own runtime-hook surface is where the SDK loads.

## Authority

- `packages/core/src/installers/javascript.ts` — four new `plan<Framework>` functions (`planRemix`, `planSvelteKit`, `planNuxt`, `planAstro`), four new detection helpers (`findRemixEntry`, `findSvelteKitHooks`, `findNuxtConfig`, `findAstroConfig`), and the extended detection chain inside `plan()`.

## Enforcement

`describe('ADR-074 — neat sync + env-dimension + framework installers')` → nested `describe('§3 framework installer paths')` in `packages/core/test/audits/contracts.test.ts`. Assertions land alongside each framework's implementing PR; pre-implementation rows surface as `it.todo`.

Full rationale: [ADR-074](../decisions.md#adr-074--neat-sync-env-dimension-at-ingest-framework-installer-paths).
