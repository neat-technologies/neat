---
name: installer-scope
description: "The installer's deterministic scope is an explicit, bounded set of frameworks/runtimes. Out-of-scope shapes get an active bring-your-own-OTel escape-hatch message (never a broken hook file). Each in-scope target carries fixture + contract assertions + CI smoke. Framework promotion is demand-and-test gated."
governs:
  - "packages/core/src/installers/javascript.ts"
  - "packages/core/src/installers/python.ts"
  - "packages/core/src/orchestrator.ts"
adr: [ADR-082, ADR-085]
enforcement: [lint, review]
---

# Installer scope contract

The receiver works regardless of how spans arrive; the installer's deterministic coverage is bounded explicitly. This contract names the boundary and the behavior on each side of it.

## 1. In-scope set (deterministic install)

Vanilla Node (Express, Fastify, Koa, raw HTTP), Next.js (all Router + bundler + layout variants), Remix, SvelteKit, Nuxt, Astro, Python (Flask, FastAPI, Django). Each in-scope target carries a baseline fixture, contract assertions, and at least one CI smoke. The `/neat extend` tools recognize each framework's instrumentation file as the modification target.

## 2. Out-of-scope set (bring-your-own-OTel)

Bun, Deno, Cloudflare Workers, AWS Lambda layers (ADOT is canonical), Vercel Edge Functions, React Native / Expo, Electron. For each, the README + `docs/installer-scope.md` document a manual OTel setup snippet pointing at NEAT's project-scoped URL and the `OTEL_SERVICE_NAME` to use.

## 3. Out-of-scope detection is active, not silent

On detecting an out-of-scope shape during discovery, the orchestrator emits a message naming the runtime and the manual setup path, then exits cleanly (not exit 1). Detection signals: `wrangler.toml` → Workers; `bun.lockb` → Bun; `deno.json` + `deno.lock` → Deno; `app.json` with an `expo` block → Expo/React Native; `package.json#engines.electron` → Electron.

## 4. An out-of-scope project never receives a broken hook

The installer writes zero files and modifies zero deps under an out-of-scope project. A Workers or Deno project must not get a Node OTel hook written into it. Silent skipping and broken-file writing are both forbidden — the orchestrator names the runtime and points at the manual path.

## 5. Framework promotion is demand-and-test gated

A framework moves from out-of-scope to in-scope only when all three hold: (a) demand — 10+ users requesting or top-20 npm framework rank; (b) stability — the recommended OTel pattern is stable across two minor versions; (c) coverage — a fixture, contract assertions, and a CI smoke land alongside the promotion. Speculative breadth is not added.
