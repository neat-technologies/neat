---
name: framework-installers
description: The JS SDK installer extends the framework dispatch pattern v0.3.8 introduced for Next.js to Remix, SvelteKit, Nuxt, and Astro. Each framework adds one detection signal, one `plan<Framework>` function, and one new entry in `plan()`'s dispatch chain. Detection precedence is Next → Remix → SvelteKit → Nuxt → Astro → vanilla Node. Next.js also grows a second generated file, `instrumentation.edge.{ts,js}`, wired through `@vercel/otel` for edge-runtime span coverage (ADR-126) — the pattern's first named exception to the four-deps invariant. Amends — does not supersede — `sdk-install.md`.
governs:
  - "packages/core/src/installers/javascript.ts"
adr: [ADR-126, ADR-074, ADR-073, ADR-047, ADR-069, ADR-070]
enforcement: [lint, review]
---

# Framework installer paths contract

Amends [`sdk-install.md`](./sdk-install.md) for the four meta-frameworks beyond Next.js. The four-deps invariant, the lockfiles-never rule, the plan/apply decoupling, and the per-project `.env.neat` `OTEL_SERVICE_NAME` shape from [`sdk-install.md`](./sdk-install.md) §Per-project (amended v0.4.1 — refs #339) all hold for every framework branch. Each branch adds one `plan<Framework>` function and one detection-chain entry in `plan()`, and threads the project name through `planNext` / `planRemix` / `planSvelteKit` / `planNuxt` / `planAstro` to the shared `queueEnvNeat` helper.

Seven sections, one rule each.

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

No framework branch swaps in a framework-specific OTel package — the auto-instrumentation set already covers HTTP / fetch / DB-driver tracing for every framework named here, with one documented exception: the Next.js edge-runtime file (§7, ADR-126), scoped to that single generated file because the standard SDK has no path to run there. Versions are pinned in `installers/javascript.ts`'s `SDK_PACKAGES` constant; framework branches read the same constant.

Lockfiles remain untouched (per [`sdk-install.md`](./sdk-install.md) — `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` are operator territory; `neat init --apply` writes manifest edits only). Manifest edits use the four-deps `add` shape; existing deps are skipped on idempotency.

The entry-point injection path (`pkg.main` / `bin` / `scripts.start` / `src/…`) from ADR-069 §2 + ADR-070 is skipped for every framework branch — the framework owns the boot path, and a `require('./otel-init')` injection into `pkg.main` would be ignored (or worse, re-run after the framework's hook). The framework's own runtime-hook surface is where the SDK loads.

## 7. Next.js edge-runtime branch

Next.js already sits first in the detection chain (§1) with its own `plan()` branch, `planNext`. This section extends that existing dispatch with a second generated file rather than adding a new framework branch — Vercel's own platform, not a new meta-framework, is what introduces the seam this closes.

**Detection signal:** unchanged. The existing Next.js signal (`sdk-install.md`'s `next` dependency + `next.config.{js,mjs,ts}`) is what routes a package into `planNext` in the first place; no separate detection is needed for the edge file, since it rides along with a plan that's already being built.

**Apply surface:**

- `planNext` gains a third generated file, `instrumentation.edge.{ts,js}`, alongside the existing `instrumentation.ts` / `instrumentation.node.ts` pair.
- `instrumentation.ts`'s existing `NEXT_RUNTIME === 'nodejs'` branch gains a sibling: `if (process.env.NEXT_RUNTIME === 'edge') { await import('./instrumentation.edge') }`.
- `instrumentation.edge.ts`'s body is `@vercel/otel`'s `registerOTel()`, configured with the same service name and OTLP endpoint every other generated init already resolves from `daemon.json` (`project-daemon.md`, ADR-096) — no new config surface, no new env var.
- The install plan still records `framework: 'next'`; the edge file is additive to that plan, not a plan of its own.

**Why this shape:** `@opentelemetry/sdk-node` cannot execute in a V8-isolate edge runtime — a platform limit, not a gap in the Node-only approach the installer already took. What's been dark until now is the half of a Vercel-deployed Next.js app that runs there: middleware and any handler declaring `export const runtime = 'edge'`. `@vercel/otel` is runtime-aware and configures the OTel SDK with web-standard APIs, so one registration call covers both runtimes, exporting over the same OTLP protocol every other generated init already speaks — no new backend, no new wire format, no Vercel-detection logic needed since the package is inert off Vercel.

This is the first named exception to §6's four-deps invariant, scoped narrowly to this one generated file: `instrumentation.edge.ts` depends on `@vercel/otel` in place of the standard four, because the standard SDK can't run there at all. Every other Next.js file — `instrumentation.node.ts`, and the Node-runtime dependency set generally — still uses the standard four. Full rationale: [ADR-126](../decisions.md#adr-126--vercel-gains-ambient-edge-runtime-tracing-via-an-installer-path-not-a-connector).

## Authority

- `packages/core/src/installers/javascript.ts` — four new `plan<Framework>` functions (`planRemix`, `planSvelteKit`, `planNuxt`, `planAstro`), four new detection helpers (`findRemixEntry`, `findSvelteKitHooks`, `findNuxtConfig`, `findAstroConfig`), and the extended detection chain inside `plan()`. §7's edge-runtime file lands as an extension of the existing `planNext`, not a new function — same file, same authority.

## Enforcement

`describe('ADR-074 — neat sync + env-dimension + framework installers')` → nested `describe('§3 framework installer paths')` in `packages/core/test/audits/contracts.test.ts`. Assertions land alongside each framework's implementing PR; pre-implementation rows surface as `it.todo`. §7's edge-runtime branch follows the same rule — its assertions land with ADR-126's implementing PR.

Full rationale: [ADR-074](../decisions.md#adr-074--neat-sync-env-dimension-at-ingest-framework-installer-paths) (framework dispatch pattern) and [ADR-126](../decisions.md#adr-126--vercel-gains-ambient-edge-runtime-tracing-via-an-installer-path-not-a-connector) (§7's edge-runtime branch).
