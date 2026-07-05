---
name: connectors
description: The connectors plane — a second OBSERVED ingestion path (pull) alongside OTLP (push). One provider interface, ambient/passive only, fusion at the same file-grain call site OTLP ingest already targets. Supabase, Railway, Firebase, and Cloudflare Workers/Pages are built providers; every provider's outbound call routes through the shared junction layer (timeout, retry, per-account rate limiting); how a connector gets configured with real credentials lives in the sibling connector-config.md contract.
governs:
  - "packages/core/src/connectors/**"
adr: [ADR-124, ADR-127, ADR-128, ADR-129, ADR-130, ADR-131]
enforcement: [lint, review]
---

# Connectors contract

NEAT's OBSERVED layer has had exactly one ingestion path: OTLP, an app pushing spans it was instrumented to emit. A connector is the second path — a provider that already runs its own server-side telemetry (a hosted Postgres platform's query stats, a hosting platform's request logs) gets **pulled** from instead, so OBSERVED edges exist with zero app instrumentation. Supabase is the first provider (ADR-124); Vercel is next.

## 1. One provider interface, many providers

A connector implements one shape:

```ts
interface ObservedConnector {
  readonly provider: string          // 'supabase', 'vercel', ...
  poll(ctx: ConnectorContext): Promise<ObservedSignal[]>
}
```

`ObservedSignal` is provider-agnostic: a `(target, callCount, lastObservedIso, callSite?)` tuple the connector's provider-specific mapping layer produces from whatever the provider's API returns. The pull/map/fuse pipeline that turns an `ObservedSignal[]` into graph mutations is written once, in `neatd`, and is identical for every provider. Only three things vary per provider: how the signal is fetched (the provider's own API shape), how a signal's `target` resolves to a NEAT node id (provider-specific — a Supabase table isn't a Vercel deployment), and poll cadence.

Provider-specific code lives under `packages/core/src/connectors/<provider>/`, mirroring the `extract/calls/<framework>.ts` per-framework split. Provider-agnostic pull/map/fuse plumbing lives at `packages/core/src/connectors/index.ts`.

## 2. Passive and ambient — never forces traffic

A connector only reads telemetry the provider already emits on its own. It never issues a synthetic request, never probes an endpoint to see if it's alive, never writes to the provider on the read path. This is the same ambient-observation discipline OTLP ingest already holds (`otel-ingest.md` — non-blocking receiver, never backpressures the observed system) applied to a pull model: a connector that generates its own traffic to observe would be indistinguishable from load on the target, and would corrupt the very signal ("the app called X 5,000 times") it exists to report.

## 3. Two credential profiles, one connector

A connector runs in one of two profiles:

- **Local** — runs on the developer's machine using their own credentials against their own project; on-demand poll (daemon tick / `neat sync`).
- **Hosted** — runs on infrastructure NEAT operates, using credentials brokered on the customer's behalf; continuous, metered poll.

Profile changes credential source, deployment location, and poll cadence. It never changes the pull/map/fuse logic — a provider implementation that branches its mapping logic on profile is a contract violation. Least-privilege is mandatory for the hosted profile specifically: a broad, unscoped credential (a database superuser password, a platform's account-owner token) held by infrastructure NEAT operates on a customer's behalf is a breach-equals-total-compromise liability that a developer holding their own credentials on their own machine isn't. Every provider's hosted-profile credential path is scoped to the narrowest read grant the provider's own auth model allows, even when that means a hosted cut ships with a smaller surface than the local profile until a broader read-only grant becomes available (ADR-124 §Consequences documents this trade-off for Supabase's first cut).

## 4. Fusion targets the same file-grain call site OTLP ingest does

A connector's OBSERVED edge reconciles onto the EXTRACTED call site the same way a span-derived edge does (file-awareness.md §4, `otel-ingest.md`'s in-process-DB / queue / GraphQL / gRPC sections): when the provider's signal names something a static extractor already resolves to a node id, the edge lands file-grained on that node via the identical `upsertObservedEdge` / `reconcileObservedRelPath` path OTLP ingest uses. When no static call site resolves — the extractor doesn't parse the shape yet, or the code isn't in this scan — the edge lands service-level (or provider-node-level), honestly, which is the missing-extracted divergence surfacing exactly what it should: production traffic the codebase's static picture doesn't account for.

This means connector node identity must be chosen so a *future* static extractor for the same provider fuses onto the same id rather than twinning — the same observed-first discipline `otel-ingest.md` documents for GraphQL operations (ADR-122) and gRPC methods (ADR-123).

## 5. No mocks on the poll path

A connector's `poll()` never runs against a mock or a synthetic fixture in production — the same rule `docs/contracts.md` Rule 5 states for the rest of NEAT's runtime. Tests exercise `poll()` against recorded real provider responses (real Management API log-query shapes, real `pg_stat_statements` rows), not synthetic shapes a real project wouldn't emit.

## 6. Credentials never reach the snapshot

A connector's config/broker state holds the credential. The graph records existence only — a node for the provider connection, never the secret itself, matching the `.env`-contents rule `docs/contracts.md` Rule 4 already states for local config.

## Authority

`packages/core/src/connectors/index.ts` owns the provider-agnostic pull/map/fuse pipeline. Each `packages/core/src/connectors/<provider>/` owns its own signal-fetch and target-resolution logic and answers to nothing else for that provider's shape.

## Enforcement

`enforcement: [lint, review]`. **Lint:** `contracts.test.ts`'s "Connectors plane contract (ADR-124)" block checks the provider-interface shape (§1 — `ObservedConnector`/`ConnectorContext`/`ObservedSignal` declared as specified) and the credential-in-config-not-snapshot rule (§6 — `credentials` never appears on the same line as a graph mutation call in `connectors/**`) mechanically, plus a scoped regression guard that `connectors/index.ts` never mutates the graph directly (ADR-030). **Review:** everything else — the passive/ambient discipline (§2), the two-credential-profile split (§3), and each provider's own fusion pattern (§4) — stays a human call until a provider's `poll()`/mapping code gives it something concrete to check against.

Full rationale: [ADR-124](../decisions.md#adr-124--the-supabase-connector-and-the-connectors-plane).
