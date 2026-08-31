---
name: connectors
description: The connectors plane — a second OBSERVED ingestion path (pull) alongside OTLP (push). One provider interface, ambient/passive only, fusion at the same file-grain call site OTLP ingest already targets. Supabase, Railway, Firebase, Cloudflare Workers/Pages, Neon, Cloud Run, GCP HTTP(S) Load Balancer, Render, PlanetScale, and EAS are built providers; every provider's outbound call routes through the shared junction layer (timeout, retry, per-account rate limiting); how a connector gets configured with real credentials lives in the sibling connector-config.md contract.
governs:
  - "packages/core/src/connectors/**"
adr: [ADR-124, ADR-127, ADR-128, ADR-129, ADR-130, ADR-131, ADR-132, ADR-133, ADR-136, ADR-156, ADR-165, ADR-166, ADR-175, ADR-185, ADR-218]
enforcement: [lint, review]
---

# Connectors contract

NEAT's OBSERVED layer has had exactly one ingestion path: OTLP, an app pushing spans it was instrumented to emit. A connector is the second path — a provider that already runs its own server-side telemetry (a hosted Postgres platform's query stats, a hosting platform's request logs) gets **pulled** from instead, so OBSERVED edges exist with zero app instrumentation. Supabase is the first provider (ADR-124); Supabase, Railway, Firebase, Cloudflare, Neon, Cloud Run, GCP HTTP(S) Load Balancer, Render, and PlanetScale are the built pull providers. Railway, Render, Cloud Run, and the GCP HTTP(S) Load Balancer all pull a hosting/edge platform's own HTTP request logs and fuse them onto the `RouteNode` static route extraction already builds (ADR-127, ADR-165, ADR-166, ADR-218). The GCP Load Balancer connector (ADR-218) reads the same Cloud Logging `entries.list` surface Cloud Run does, pinned to the external Application Load Balancer's own `http_load_balancer` request log, and keys its signal on the log's `backend_service_name` — the fusion twin of Cloud Run's `service_name` — so an LB in front of GKE or Compute Engine (which emit no per-service request log the way Cloud Run does) still lights up route-grain OBSERVED edges. Neon and PlanetScale pull a hosted database's own query telemetry and fuse it onto the `sql-table` nodes the SQL/ORM extractors build (ADR-156, ADR-175).

Neon (ADR-156) uses the database's cumulative `pg_stat_statements` view because Neon's management and consumption APIs do not expose table-grained query telemetry. A dedicated `LOGIN` role granted only `pg_read_all_stats` reads through the shared DB junction and a read-only session guard. Positive counter deltas from conservatively parsed single-table statements resolve with `infraId('sql-table', table)`, exactly matching the SQLAlchemy and Django ORM extractors. The first poll and a reset establish baselines and emit nothing; unique static attribution sharpens the source to a file, while ambiguity stays service-grained.

PlanetScale (ADR-175) reads the Query Insights API and fuses onto the same `infraId('sql-table', table)` id, more cleanly than the `pg_stat_statements` path: each query fingerprint comes back with its `tables` already parsed and its `query_count` already windowed to the poll interval, so the connector needs neither Neon's FROM-clause parsing nor its cumulative-counter delta bookkeeping. One signal is emitted per table a fingerprint touched; `error_count` is a real per-window failure signal the `pg_stat_statements` path has none of. The credential is the narrowest PlanetScale grants — a per-database `read_database` service token, read-only, sent in PlanetScale's non-Bearer `id:token` header form. Where no `sql-table` node exists yet the signal stays honestly at the provider level (a `planetscale-database` node, §4a) rather than fabricating a table. The honest ceiling is table grain — Insights aggregates per fingerprint, so there is no row or column grain, and file grain appears only transitively when the resolved table node carries a real call site.

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

Most connectors observe *traffic* — a call happened, a query ran — and the signal counts it onto an edge. A minority observe a *failure event* the provider already recorded (a CI build that broke, a scheduled job that threw). Those carry an optional `incident` payload on the signal and land as an OBSERVED incident on the repo node the failure implicates, not an edge — the **incident-emitting** shape §10 defines. It reuses the same `poll()`/`ObservedSignal` interface (the field is additive and optional) and the same `resolveTarget` fusion; only the terminal write differs (an `ErrorEvent` on the incident ledger instead of an `upsertObservedEdge`).

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
- **Ingress target** (a `RouteNode`): a route has no inbound `file → route` edge to attribute through — routes.ts owns it via `service ──CONTAINS──▶ route` — but the RouteNode already records its own definition site (`path`, `line`). So a route-targeting connector (Cloudflare Workers, Firebase Hosting, Render) file-grains onto that recorded site directly (ADR-143), the same site routes.ts parsed the route from. This generalizes what Railway already does per-connector — reading `route.path`/`route.line` into its own signal `callSite` — into the shared pipeline, so every route-targeting connector file-grains the same way.

So growing the static extractor (or recognizing a Worker's router) is what sharpens a connector to file grain; no new provider telemetry is required, and none exists that would carry it.

This means connector node identity must be chosen so a *future* static extractor for the same provider fuses onto the same id rather than twinning — the same observed-first discipline `otel-ingest.md` documents for GraphQL operations (ADR-122) and gRPC methods (ADR-123).

### 4a. A `resolveTarget` can declare an honest fallback node, never create one itself (ADR-133)

A provider module has no mutation authority (ADR-030) — `createSupabaseResolveTarget` and Cloudflare's own `createCloudflareResolveTarget` both hit this: the provider's signal can name a resource no static extractor has (yet) declared, and `resolveTarget` cannot mint the node itself. The generic pipeline (`connectors/index.ts`) is the one place with ingest.ts mutation authority, so the fallback is expressed *declaratively*: `ResolvedConnectorTarget` carries an optional `ensureInfraNode?: { kind: string; name: string; provider: string }`. When set, `runConnectorPoll` calls `ensureInfraNode(graph, kind, name, provider)` (`ingest.ts`, mirroring the existing `ensureServiceNode`/`ensureDatabaseNode` shape) before minting the edge, so the observed-but-undeclared case lands a real edge — surfacing as a `missing-extracted` divergence — instead of a silent drop. This is additive to the pipeline; it changes no existing provider's behavior unless that provider's `resolveTarget` opts in. Cloudflare's `createCloudflareResolveTarget` is the first user: an invocation naming a Worker script absent from both the tagged graph (ADR-133's `platform`/`platformName` fields, `static-extraction.md`) and the connector config's explicit override falls back to `infraId('cloudflare-worker', scriptName)`, sourced from an auto-created `service:<scriptName>` the same way every other connector's call-site-less case already auto-creates its source. Cloud Run's `createCloudRunResolveTarget` is the second user (ADR-165): a request-log entry whose normalized `(method, path)` matches no `RouteNode` the mapped service declares falls back to `infraId('cloud-run-service', service_name)` — the Cloud Run service the log's own `resource.labels.service_name` names, a real platform resource, never a fabricated route — so production traffic on an un-extracted route surfaces as a `missing-extracted` divergence rather than a silent drop, and a future Cloud Run service-manifest extractor fuses onto that same id. The GCP HTTP(S) Load Balancer's `createGcpLbResolveTarget` is the third user (ADR-218): a request whose `(method, path)` matches no `RouteNode` the mapped backend declares falls back to `infraId('gcp-lb-backend', backend_service_name)` — the LB backend service the log's own `resource.labels.backend_service_name` names, again a real platform resource rather than a fabricated route — reserved so a future GCP load-balancing/backend-service extractor fuses onto that same id.

## 5. No mocks on the poll path

A connector's `poll()` never runs against a mock or a synthetic fixture in production — the same rule `docs/contracts.md` Rule 5 states for the rest of NEAT's runtime. Tests exercise `poll()` against recorded real provider responses (real Management API log-query shapes, real `pg_stat_statements` rows), not synthetic shapes a real project wouldn't emit.

## 6. Credentials never reach the snapshot

A connector's config/broker state holds the credential. The graph records existence only — a node for the provider connection, never the secret itself, matching the `.env`-contents rule `docs/contracts.md` Rule 4 already states for local config.

## 7. A connector's mapping layer emits a `LogEntry` alongside its `ObservedSignal` (ADR-132)

The raw provider record a connector's `map.ts` reads (a Railway `httpLogs` row, a Firebase `LogEntry`, a Cloudflare invocation record, a Supabase `edge_logs` row) carries more than the graph needs — a full request/invocation record, not just a count. Each connector emits a `LogEntry` (`logs.md`) for that same raw record, tagged `source: '<provider>'`, in addition to the `ObservedSignal` it already produces. This is additive: `poll()`'s signature, the `ObservedSignal` shape, and every existing signal-mapping test are unaffected — a connector's mapping layer now produces two outputs from one input instead of one, not a different one.

Neon's `pg_stat_statements` row is the bounded exception (ADR-156): it is an aggregate counter snapshot with no event timestamp or individual invocation record, so it emits only the counter-delta `ObservedSignal`. Turning query text plus poll time into a `LogEntry` would fabricate an event. Neon logs remain available through OTLP when an operator configures Neon's separate monitoring export; this pull connector does not synthesize them.

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

## 8.1. Poll on demand — a manual trigger (#871)

`POST /:project/connectors/:id/poll` (dual-mounted per ADR-026) runs one poll of the named connector immediately and returns the outcome — the operator's tool for verifying a freshly-added connector rather than waiting a full interval, and the diagnostic the pilot lacked entirely. It reuses the **same** `buildRegistration` + `runConnectorPoll` the background loop (§1–§7) uses, against the project's live in-memory graph, and records the tick through the same status tracker (§8), so a manual poll and a background poll are indistinguishable on `GET /connectors`. The read-only discipline (§2) holds: the trigger only asks the provider for telemetry it already emits, never writes to it. Responses: `200 {id, outcome: 'ok', signalsLastPoll, status}`; `404` for an unknown id; `409` for a push provider (§9 — its data arrives via OTLP, there is nothing to poll); `400` for a genuinely broken entry (unknown provider / missing field / unresolved credential); `502 {id, outcome: 'error', error, status}` when the poll itself throws, with `error` run through the same `sanitizePollError` §8 uses so no secret leaks.

## 9. Push providers (drains) — provision instead of poll (ADR-146)

The intro named two connector shapes. §1–§8 govern the **pull** shape: a `poll()` the daemon calls on a cadence. A **push** provider inverts the direction — its telemetry has no pull API but the provider *can be told to forward* it, so NEAT configures the provider to push to the daemon's own OTLP receiver (`/v1/traces`, `otel.ts`). The OBSERVED layer then falls out of the exact ingest path an instrumented app uses — no new receive path, no `poll()`. **Vercel is the first push provider** (its runtime traces have no pull endpoint; a Vercel *Drain* forwards them as OTLP/HTTP).

A push provider registers in a **second dispatch table** — `PUSH_PROVIDER_DISPATCH` (`connectors/registry.ts`), parallel to `PROVIDER_DISPATCH` — carrying the same field schema the pull table does (`primaryCredentialKey`, `requiredCredentialFields`, `requiredOptionFields`) so `neat connector add` prompts and validates identically, plus a **lifecycle** the pull shape has no need for:

- **`validate(input)`** — the same cheap round-trip §4 names, run by `add` (pre-provision) and `test`. For a drain this both authenticates the provider credential *and* confirms the daemon's OTLP endpoint is reachable and accepts the drain's auth (Vercel's `POST /v1/drains/test` pings the endpoint with a sample event; a `success` verdict means both held). A push provider's endpoint must be **publicly reachable** — a local daemon is fronted by a tunnel, a hosted daemon exposes its own URL — and `validate` is where an unreachable endpoint fails fast, before anything is provisioned.
- **`provision(input)`** — creates the provider-side resource (the drain) and returns an opaque handle (`{ drainId }`) merged into the entry's `options`. Run by `add` after `validate` passes. The daemon-side ingest already exists (the OTLP receiver), so provisioning is the *only* write a push `add` makes beyond the config entry.
- **`deprovision(input)`** — deletes that resource, run by `remove` before the entry is dropped; idempotent (an already-gone drain is a success, not an error). `remove` on a push provider is therefore not a pure config edit — it reaches the provider to tear the drain down, so a stored entry is never orphaned from a live drain.

**Credential shape.** A push provider's credential is multi-field where the drain needs two secrets: the **provider API token** (`token` — authenticates provision/deprovision/validate) and the **daemon's OTLP bearer** (`otelToken` — the value the drain sends as its `Authorization` header so the receiver, which requires a bearer per ADR-073 §4, accepts the pushed spans). Both are env-refs by default, resolved only at command time, exactly as §2/§6 require — neither reaches `connectors.json` or the snapshot. The `otelToken` does come to rest **provider-side** (the drain stores its own delivery header); that is inherent to any drain destination and out of NEAT's snapshot scope.

**The daemon skips push entries.** `buildRegistration` produces no `ConnectorRegistration` for a push provider — there is nothing to poll — and does so as a *benign, expected* skip, distinct from the "unknown provider" skip a malformed entry gets. `options.drainId` and the endpoint travel in the entry only so `remove`/`test`/`list` can act on the live drain; the poll loop never reads them.

## 10. Incident-emitting connectors — a failure-event grain (ADR-185)

§1–§9 describe connectors that observe *traffic* and fuse it onto an edge. A second, narrower kind observes a **failure event** the provider already recorded and maps it onto the repo node responsible, so an agent can query `get_incident_history` / `get_root_cause` over it and fix the cause in the repo. **EAS is the first** (ADR-185): it pulls `ERRORED` Expo/EAS builds from the Expo GraphQL API and mints one OBSERVED build-failure incident per build. **Kubernetes is the second** (#1124): it pulls read-only cluster state (Deployments + Pods, one namespace) and mints an OBSERVED incident on a service node when a workload is down for a *deployment* reason — a bad image (`ImagePullBackOff`), zero replicas (`spec.replicas: 0`), a crashloop (`CrashLoopBackOff`). These are exactly the faults a dead pod emits no span for, so the graph is otherwise blind to them; the connector reads them straight from the cluster and fuses each onto the same `ServiceNode` the extractor built. The failure event is a **current-state** fact rather than a discrete past event, so — unlike EAS's per-build id — its dedupe id is stable per `(namespace, deployment, fault)`, collapsing a re-polled fault to one incident and minting a distinct one when the fault changes.

- **Incident, not edge.** The signal carries an optional `incident` payload (`connectors/types.ts`) — a stable dedupe `id`, the failure `timestamp`, the `errorType`/`errorMessage`, and provider `attributes`. When a signal carries one, `runConnectorPoll` writes an `ErrorEvent` to the project's incident ledger (`errors.ndjson`) through an `ingest.ts` primitive (`appendConnectorIncident`) — the **same** ledger and the same `affectedNode` model OTLP-derived incidents use (`otel-ingest.md`), never a parallel store — instead of minting an edge. `ConnectorContext` gains an optional `errorsPath` so the pipeline knows where that ledger is; a context without it (a programmatic caller that opts out) simply drops the incident, the same honest no-op a null `resolveTarget` is. Mutation authority is unchanged (§4a, ADR-030): the pipeline is still the only writer, and the connector module never touches the ledger itself.
- **Pushed like any incident (ADR-221).** After the ledger write, `appendConnectorIncident` fires the `incident` push event on the bus — the same lean payload and id-dedupe an OTLP-derived incident emits — so an agent's `neat monitor` wakes on a connector failure too, not only an app-instrumented one. `ConnectorContext` gains an optional `project` threaded from the poll caller (the file-loop and the manual `POST /connectors/:id/poll` both supply it); a programmatic caller that threads none still writes the ledger, it just doesn't push. The push is off the same `emitIncidentEvent` the OTLP paths use, so the two are indistinguishable on the bus.
- **Fuse onto the extracted node, never a twin.** `resolveTarget` resolves the incident's `affectedNode` through the same fused-node lookup the OTLP incident path uses (`resolveFusedServiceId`, #988/#992) so it lands on the node the *extractor* produced, not a connector-minted twin. For EAS the map is by `error.buildPhase` (a strict enum): config/dependency phases land on the `app.json` / `eas.json` ConfigNode the extractor mints for those files (a JSON build-config extraction added alongside this connector), and native-compile phases land on the app's ServiceNode with the build logs attached in the incident `attributes` for the agent to read. An incident whose `affectedNode` isn't in the graph is dropped honestly (the same missing-target discipline §4 states for edges), never written onto a fabricated node.
- **Commit grain.** The request-log connectors fuse onto a `RouteNode` (route grain, §4). A build failure has no route — it ran the whole repo at one commit — so it fuses at **commit grain**: the incident carries `gitCommitHash` / `gitRef`, the exact join back to source. `isGitWorkingTreeDirty` tags the incident lower-confidence (the commit may not represent what actually built).
- **Transient/infra failures mint nothing.** A provider outage comes back wearing the same failure status as a real repo bug. An incident-emitting connector must exclude the infra/credentials/transient class (for EAS: the `SPIN_UP_BUILDER` / `PREPARE_CREDENTIALS` / `RESTORE_CACHE` / internal phases and `INTERNAL_SERVER_ERROR`-class error codes) so an EAS outage never mints a repo divergence. Classification switches on the provider's **stable** enums (`status` + `buildPhase`); free-text fields (`errorCode`) are a hint handed to the agent, never a strict classifier.
- **Undocumented API → fail loud.** The Expo GraphQL API is undocumented and unversioned. The query set is pinned, and a schema/shape error surfaces as a clear connector error (the drift signal §8's status tracker records), never a silent drop of builds.

The `LogEntry` side-output (§7) is out of scope for this shape: a build failure has no per-request record to log, and its logs ride in the incident `attributes` (fetched-and-capped, since Expo's log URLs are time-limited and can be large). This mirrors §7's Neon exception — a signal with no discrete event record emits no `LogEntry`.

## Authority

`packages/core/src/connectors/index.ts` owns the provider-agnostic pull/map/fuse pipeline. Each `packages/core/src/connectors/<provider>/` owns its own signal-fetch and target-resolution logic and answers to nothing else for that provider's shape. `packages/core/src/connectors/status.ts` owns the in-process poll-status tracker (§8) — the poll loop is its only writer, the connector-status endpoint its only reader. The endpoint itself is a route in `packages/core/src/api.ts`, governed by `rest-api.md`.

## Enforcement

`enforcement: [lint, review]`. **Lint:** `contracts.test.ts`'s "Connectors plane contract (ADR-124)" block checks the provider-interface shape (§1 — `ObservedConnector`/`ConnectorContext`/`ObservedSignal` declared as specified) and the credential-in-config-not-snapshot rule (§6 — `credentials` never appears on the same line as a graph mutation call in `connectors/**`) mechanically, plus a scoped regression guard that `connectors/index.ts` never mutates the graph directly (ADR-030). **Review:** everything else — the passive/ambient discipline (§2), the two-credential-profile split (§3), and each provider's own fusion pattern (§4) — stays a human call until a provider's `poll()`/mapping code gives it something concrete to check against.

Full rationale: [ADR-124](../decisions.md#adr-124--the-supabase-connector-and-the-connectors-plane).
