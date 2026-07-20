---
name: connectors
description: The connectors plane — a second OBSERVED ingestion path (pull) alongside OTLP (push). One provider interface, ambient/passive only, fusion at the same file-grain call site OTLP ingest already targets. Supabase, Railway, Firebase, and Cloudflare Workers/Pages are built providers; every provider's outbound call routes through the shared junction layer (timeout, retry, per-account rate limiting); how a connector gets configured with real credentials lives in the sibling connector-config.md contract.
governs:
  - "packages/core/src/connectors/**"
adr: [ADR-124, ADR-127, ADR-128, ADR-129, ADR-130, ADR-131, ADR-132, ADR-133, ADR-136]
enforcement: [lint, review]
---

# Connectors contract

NEAT's OBSERVED layer has had exactly one ingestion path: OTLP, an app pushing spans it was instrumented to emit. A connector is the second path — a provider that already runs its own server-side telemetry (a hosted Postgres platform's query stats, a hosting platform's request logs) gets **pulled** from instead, so OBSERVED edges exist with zero app instrumentation. Supabase is the first provider (ADR-124); Supabase, Railway, Firebase, and Cloudflare are the built pull providers.

There are two connector **shapes**. Most providers use the **pull** shape below (`poll()` an API on a cadence). A provider whose telemetry has no pull API but *can push* uses the **drains/push** shape: NEAT configures the provider to forward its telemetry to the daemon's own OTLP receiver, and OBSERVED falls out of the same OTel-ingest path an instrumented app uses. **Vercel** is the first drains provider (ADR-146) — it exposes no pull API for runtime invocations, so `neat connector add vercel` creates a Vercel trace-drain pointed at the daemon's `/v1/traces`. The pull interface and everything below describe the pull shape; the drains shape reuses the existing OTLP receiver and adds only a provider-side drain-setup step.

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

The **source** grain comes from a call site three ways (#803). A signal may carry its own `callSite` (Railway's `httpLogs`, matched to the handler route). When it doesn't — the common pull-API case, where provider telemetry records the target but never the caller — the pipeline recovers the call site two ways depending on what kind of node the target is:

- **Egress target** (a table, a bucket, a queue): the pipeline **attributes** the observation to the file that statically makes the call — if exactly one file in the emitting service holds an EXTRACTED edge to the observed target (e.g. `<client>.from('orders')` → `file → supabase-table:orders`, extracted by `extract/calls/supabase.ts`), the OBSERVED edge originates from that file, `grain: 'file'` (ADR-142). Two or more candidate files, or none, stays service-coarse — the attribution is a fact, never a guess.
- **Ingress target** (a `RouteNode`): a route has no inbound `file → route` edge to attribute through — routes.ts owns it via `service ──CONTAINS──▶ route` — but the RouteNode already records its own definition site (`path`, `line`). So a route-targeting connector (Cloudflare Workers, Firebase Hosting) file-grains onto that recorded site directly (ADR-143), the same site routes.ts parsed the route from. This generalizes what Railway already does per-connector — reading `route.path`/`route.line` into its own signal `callSite` — into the shared pipeline, so every route-targeting connector file-grains the same way.

So growing the static extractor (or recognizing a Worker's router) is what sharpens a connector to file grain; no new provider telemetry is required, and none exists that would carry it.

This means connector node identity must be chosen so a *future* static extractor for the same provider fuses onto the same id rather than twinning — the same observed-first discipline `otel-ingest.md` documents for GraphQL operations (ADR-122) and gRPC methods (ADR-123).

### 4a. A `resolveTarget` can declare an honest fallback node, never create one itself (ADR-133)

A provider module has no mutation authority (ADR-030) — `createSupabaseResolveTarget` and Cloudflare's own `createCloudflareResolveTarget` both hit this: the provider's signal can name a resource no static extractor has (yet) declared, and `resolveTarget` cannot mint the node itself. The generic pipeline (`connectors/index.ts`) is the one place with ingest.ts mutation authority, so the fallback is expressed *declaratively*: `ResolvedConnectorTarget` carries an optional `ensureInfraNode?: { kind: string; name: string; provider: string }`. When set, `runConnectorPoll` calls `ensureInfraNode(graph, kind, name, provider)` (`ingest.ts`, mirroring the existing `ensureServiceNode`/`ensureDatabaseNode` shape) before minting the edge, so the observed-but-undeclared case lands a real edge — surfacing as a `missing-extracted` divergence — instead of a silent drop. This is additive to the pipeline; it changes no existing provider's behavior unless that provider's `resolveTarget` opts in. Cloudflare's `createCloudflareResolveTarget` is the first user: an invocation naming a Worker script absent from both the tagged graph (ADR-133's `platform`/`platformName` fields, `static-extraction.md`) and the connector config's explicit override falls back to `infraId('cloudflare-worker', scriptName)`, sourced from an auto-created `service:<scriptName>` the same way every other connector's call-site-less case already auto-creates its source.

## 5. No mocks on the poll path

A connector's `poll()` never runs against a mock or a synthetic fixture in production — the same rule `docs/contracts.md` Rule 5 states for the rest of NEAT's runtime. Tests exercise `poll()` against recorded real provider responses (real Management API log-query shapes, real `pg_stat_statements` rows), not synthetic shapes a real project wouldn't emit.

## 6. Credentials never reach the snapshot

A connector's config/broker state holds the credential. The graph records existence only — a node for the provider connection, never the secret itself, matching the `.env`-contents rule `docs/contracts.md` Rule 4 already states for local config.

## 7. A connector's mapping layer emits a `LogEntry` alongside its `ObservedSignal` (ADR-132)

The raw provider record a connector's `map.ts` reads (a Railway `httpLogs` row, a Firebase `LogEntry`, a Cloudflare invocation record, a Supabase `edge_logs` row) carries more than the graph needs — a full request/invocation record, not just a count. Each connector emits a `LogEntry` (`logs.md`) for that same raw record, tagged `source: '<provider>'`, in addition to the `ObservedSignal` it already produces. This is additive: `poll()`'s signature, the `ObservedSignal` shape, and every existing signal-mapping test are unaffected — a connector's mapping layer now produces two outputs from one input instead of one, not a different one.

## 8. Connector poll health is queryable — an in-process status tracker + a read-only endpoint (ADR-136)

The poll loop's outcome is a queryable fact, not only a log line. A process-local status tracker (`packages/core/src/connectors/status.ts`) records, per connector id, on **every** tick — success and failure — `lastPollAt`, `lastOutcome` (`ok`/`error`), `lastError` (a short, secret-free string), `signalsLastPoll` (the count the tick returned), and the time of the last successful poll. `startConnectorPollLoop` is the sole writer (it takes the connector's id via `ConnectorRegistration.id` / its `connectorId` option); the connector-status endpoint is the sole reader. This is in-memory live state on the same "OBSERVED is a live signal, not an archive" footing as `logs-store.ts` — a daemon restart drops it and the next poll re-derives it, and it never touches the graph or the snapshot.

`GET /:project/connectors` (dual-mounted per ADR-026, `rest-api.md`) reads `~/.neat/connectors.json`, filters to the project (`connectorMatchesProject`), and returns one entry per connector:

```ts
{ connectors: Array<{
  id: string,
  provider: string,
  credentialRef: string | Record<string, string>,   // redacted env-ref pointer ("$CF_TOKEN"),
                                                      // or field→pointer map; a plaintext literal → "****"
  status: {
    state: 'idle' | 'healthy' | 'error' | 'stale',    // idle: no poll yet; healthy: recent ok;
                                                       // error: last tick threw; stale: no ok within the window
    lastPollAt: string | null,                         // ISO8601
    lastOutcome: 'ok' | 'error' | null,
    lastError: string | null,                          // never a credential
    signalsLastPoll: number,
  },
}> }
```

`credentialRef` reuses the same `isEnvRef`-driven redaction `neat connector list` prints, through a shared `redactCredentialRef` helper (`connectors-config.ts`); the endpoint never calls `resolveCredential`. The never-a-resolved-secret rule (§6) holds on this read surface exactly as it holds in the config file and the snapshot: the pointer is shown, the value never is — not in `credentialRef`, not in `lastError`, not in any log.

## 9. Push providers (drains) — provision instead of poll (ADR-146)

The intro named two connector shapes. §1–§8 govern the **pull** shape: a `poll()` the daemon calls on a cadence. A **push** provider inverts the direction — its telemetry has no pull API but the provider *can be told to forward* it, so NEAT configures the provider to push to the daemon's own OTLP receiver (`/v1/traces`, `otel.ts`). The OBSERVED layer then falls out of the exact ingest path an instrumented app uses — no new receive path, no `poll()`. **Vercel is the first push provider** (its runtime traces have no pull endpoint; a Vercel *Drain* forwards them as OTLP/HTTP).

A push provider registers in a **second dispatch table** — `PUSH_PROVIDER_DISPATCH` (`connectors/registry.ts`), parallel to `PROVIDER_DISPATCH` — carrying the same field schema the pull table does (`primaryCredentialKey`, `requiredCredentialFields`, `requiredOptionFields`) so `neat connector add` prompts and validates identically, plus a **lifecycle** the pull shape has no need for:

- **`validate(input)`** — the same cheap round-trip §4 names, run by `add` (pre-provision) and `test`. For a drain this both authenticates the provider credential *and* confirms the daemon's OTLP endpoint is reachable and accepts the drain's auth (Vercel's `POST /v1/drains/test` pings the endpoint with a sample event; a `success` verdict means both held). A push provider's endpoint must be **publicly reachable** — a local daemon is fronted by a tunnel, a hosted daemon exposes its own URL — and `validate` is where an unreachable endpoint fails fast, before anything is provisioned.
- **`provision(input)`** — creates the provider-side resource (the drain) and returns an opaque handle (`{ drainId }`) merged into the entry's `options`. Run by `add` after `validate` passes. The daemon-side ingest already exists (the OTLP receiver), so provisioning is the *only* write a push `add` makes beyond the config entry.
- **`deprovision(input)`** — deletes that resource, run by `remove` before the entry is dropped; idempotent (an already-gone drain is a success, not an error). `remove` on a push provider is therefore not a pure config edit — it reaches the provider to tear the drain down, so a stored entry is never orphaned from a live drain.

**Credential shape.** A push provider's credential is multi-field where the drain needs two secrets: the **provider API token** (`token` — authenticates provision/deprovision/validate) and the **daemon's OTLP bearer** (`otelToken` — the value the drain sends as its `Authorization` header so the receiver, which requires a bearer per ADR-073 §4, accepts the pushed spans). Both are env-refs by default, resolved only at command time, exactly as §2/§6 require — neither reaches `connectors.json` or the snapshot. The `otelToken` does come to rest **provider-side** (the drain stores its own delivery header); that is inherent to any drain destination and out of NEAT's snapshot scope.

**The daemon skips push entries.** `buildRegistration` produces no `ConnectorRegistration` for a push provider — there is nothing to poll — and does so as a *benign, expected* skip, distinct from the "unknown provider" skip a malformed entry gets. `options.drainId` and the endpoint travel in the entry only so `remove`/`test`/`list` can act on the live drain; the poll loop never reads them.

## Authority

`packages/core/src/connectors/index.ts` owns the provider-agnostic pull/map/fuse pipeline. Each `packages/core/src/connectors/<provider>/` owns its own signal-fetch and target-resolution logic and answers to nothing else for that provider's shape. `packages/core/src/connectors/status.ts` owns the in-process poll-status tracker (§8) — the poll loop is its only writer, the connector-status endpoint its only reader. The endpoint itself is a route in `packages/core/src/api.ts`, governed by `rest-api.md`.

## Enforcement

`enforcement: [lint, review]`. **Lint:** `contracts.test.ts`'s "Connectors plane contract (ADR-124)" block checks the provider-interface shape (§1 — `ObservedConnector`/`ConnectorContext`/`ObservedSignal` declared as specified) and the credential-in-config-not-snapshot rule (§6 — `credentials` never appears on the same line as a graph mutation call in `connectors/**`) mechanically, plus a scoped regression guard that `connectors/index.ts` never mutates the graph directly (ADR-030). **Review:** everything else — the passive/ambient discipline (§2), the two-credential-profile split (§3), and each provider's own fusion pattern (§4) — stays a human call until a provider's `poll()`/mapping code gives it something concrete to check against.

Full rationale: [ADR-124](../decisions.md#adr-124--the-supabase-connector-and-the-connectors-plane).
