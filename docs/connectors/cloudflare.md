# Cloudflare Workers/Pages connector

Fifth provider design under the [connectors plane](./README.md) (ADR-124), ratified as ADR-129.
Pulls Cloudflare's own Workers Observability telemetry and mints an OBSERVED edge onto the
Worker's entry `FileNode` — no app instrumentation required. This doc is the design; no
connector code ships with it, and `packages/core/src/extract/routes.ts` is untouched by this
cut.

## Scope

- **Target: Cloudflare Workers and Pages Functions.** Both run on the same `workerd` runtime,
  and both expose the same request-triggered `fetch` execution shape this connector reads.
- **v1 ships at whole-file grain, not route grain — deliberately, not as a placeholder.**
  Cloudflare's own telemetry thinks in scripts, not routes: the closest field to a route on
  the primary surface below is a semi-structured `trigger`/`url` string, and turning that into
  a real per-handler edge needs a static router recognizer `routes.ts` doesn't have yet (see
  §Static extractor gap). Rather than wait on that recognizer, v1 binds the signal to the
  Worker's single entry `FileNode` — the file containing `export default { fetch(request, env,
  ctx) { ... } }`, resolved from the service's `wrangler.toml`/`wrangler.jsonc` `main` field the
  same way NEAT's Node installer already resolves an entry point (`sdk-install.md`'s
  `pkg.main` → `bin` → `scripts.start/dev` → `src/…` precedence). Honest, file-grained, real
  signal, zero new static-extraction risk.
- **Pages Functions' own file-based routing is a related but separate gap, not solved here.**
  Pages Functions doesn't use the single-`fetch`-handler shape at all — it's file-based
  routing, where `/functions/fruits/apple.js` maps directly to `/fruits/apple`
  (developers.cloudflare.com/pages/functions/routing/), the same convention shape
  `routes.ts` already recognizes for Next.js's `pages/api/**`. `routes.ts` has no Pages
  Functions branch today, so a Pages Functions invocation also lands file-grained in v1 — on
  the specific function file the request hit, which happens to already be close to route grain
  because Cloudflare's own convention is file-per-route. A Pages Functions file-convention
  recognizer is a smaller, separate lift than the Hono AST recognizer below and isn't scoped by
  ADR-129; naming it here so it isn't lost.
- **Whether a Pages Functions invocation surfaces on the same telemetry dataset as a Workers
  invocation is unconfirmed — needs-endpoint-testing.** Cloudflare's Pages Functions docs
  describe `wrangler pages deployment tail` and the dashboard as the logging surfaces; nothing
  in the docs surveyed confirms or rules out Pages Functions events appearing in the Workers
  Observability Telemetry Query API's dataset. Confirm against a live Pages deployment before
  wiring the poller to assume parity.

## Surfaces used

### 1. Workers Observability Telemetry Query API (primary, both profiles)

`POST /accounts/{account_id}/workers/observability/telemetry/query`
(developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
is a documented, public, account-scoped REST endpoint. A query takes a `timeframe` window and
optional filters/group-bys and returns per-invocation records carrying, among other fields:

- `trigger` — "what triggered the invocation", e.g. `"GET /users"`, `"POST /orders"`, or a
  queue message — this is the semi-structured route-shaped string this connector parses.
- `url` — the request URL that triggered the invocation.
- `statusCode`, `duration`, `traceDuration` — response status and timing.
- `service` — the Worker script name that produced the event.

This connector's v1 parses only the HTTP method token off the front of `trigger` (`"GET"` out
of `"GET /users"`) for edge metadata — no attempt to match the remainder against a route table,
since no static route table for the framework shapes below exists yet.

- **Enablement:** a `wrangler.toml`/`wrangler.jsonc` deploy flag —
  `observability = { enabled = true, invocation_logs = true }` — with zero application code
  change. This is the strongest "no setup friction" surface surveyed across connectors so far:
  it's a deploy-time config flip, not an SDK a developer has to import and initialize.
- **Auth:** an API token scoped to Cloudflare's permission-group system. A distinct
  "Workers Tail Read" group exists (covering `wrangler tail`, a different endpoint), and a
  general "Logs Read" group also exists, but neither is confirmed by the docs surveyed as the
  specific grant the Telemetry Query API checks — needs-endpoint-testing before a hosted-profile
  broker locks in a scope name. The local profile is unaffected by this ambiguity: a developer's
  own token with broad Workers read access already works.
- **Poll cadence:** on-demand (daemon tick / `neat sync`) for local; a fixed interval for
  hosted, candidate to be set once a live rate-limit check confirms a safe value —
  needs-endpoint-testing, same discipline `supabase.md` applies to its own log-surface cadence.
- **Passive and ambient:** this is a read-only query over telemetry Cloudflare already collects
  when `observability.enabled` is on; the connector never issues a synthetic request to the
  Worker itself (connectors.md §2).

### 2. GraphQL Analytics API — secondary, not chosen for v1's fusion signal

`workersInvocationsAdaptive`, queried at
`https://api.cloudflare.com/client/v4/graphql`, is stable and well-documented — `sum.requests`,
`sum.errors`, `sum.subrequests`, and CPU/wall-time quantiles, filterable by `scriptName` and a
`datetime` range. It's strictly script-level aggregate: no path, route, or trigger dimension at
all. Useful as a coarse per-Worker health cross-check against the Telemetry Query API's
per-invocation signal, but it carries nothing this connector's fusion step needs, so v1 doesn't
poll it.

### 3. Explicitly not v1 — real, named reasons, not oversights

- **Native OpenTelemetry (OTLP) export.** Cloudflare ships this today as a genuine, documented,
  shipped feature — Workers can export OTLP-compliant traces and logs to any destination with an
  OTLP endpoint (Honeycomb, Grafana Cloud, Axiom, Sentry, and others). This is push-shaped: the
  Worker sends spans outward to a destination the developer configures, the mirror image of a
  connector's pull model. Fusing on it would need a future `connectors.md` amendment adding a
  push-receiver method (`receive()`) to the provider interface — that amendment doesn't exist
  yet and isn't being built speculatively for this connector.
- **Logpush.** Also push-only, streaming to external storage (R2, S3, Datadog, etc.) on a
  Business/Enterprise plan. Its `workers_trace_events` dataset
  (developers.cloudflare.com/logs/reference/log-fields/account/workers_trace_events/) carries
  `ScriptName`, `Outcome`, `CPUTimeMs`, `WallTimeMs`, `Exceptions`, `Logs` — genuinely no
  path, URL, route, or HTTP method field at all. Even if the push-shape problem didn't apply,
  this dataset wouldn't carry the signal this connector needs.

## Fusion — node identity

Cloudflare's Worker/script name (the `name` field in `wrangler.toml`/`wrangler.jsonc`, and the
`service` field the Telemetry Query API returns) does not generally match NEAT's
manifest-derived `serviceId(name)` (`package.json#name`) — the same gap Railway's connector
design (ADR-127) names for its own provider-specific service name. Resolving that gap is an
explicit config-time mapping, not a guess: the project's `wrangler.toml`/`wrangler.jsonc` `name`
field is read alongside `package.json#name` at connector-configuration time, and the pair is
recorded once, the same way a Railway project's service mapping is recorded once.

Once the Worker's NEAT service is known, its entry `FileNode` is `fileId(service, relPath)` —
`relPath` resolved from the same `wrangler.toml`/`wrangler.jsonc` `main` field the installer
already reads. Edge type is `CALLS`, minted file-grained via the same
`upsertObservedEdge`/`reconcileObservedRelPath` path OTLP-derived edges use
(connectors.md §4), with the parsed HTTP method and `statusCode`/`duration` carried as edge
metadata. No new `NodeType` — this is additive the same way GraphQL operations, gRPC methods,
and WebSocket channels were (ADR-031).

## Static extractor gap this connector exposes

`routes.ts` recognizes Express, Fastify, Hono, and Next.js (ADR-133 §5 lands the Hono
recognizer — `hono.get('/path', handler)`, `hono.post(...)`, and so on, gated on the `hono`
manifest dependency, the same shape the Express/Fastify recognizers already take). A
multi-route Hono Worker now resolves to real `RouteNode`s and this connector's edges sharpen
to route grain automatically — no connector-side change needed, because the fusion step
already reconciles onto whatever static call site exists for a given file/line. itty-router,
`app.on([...methods], '/path', handler)`, and a raw manual `fetch(request)` dispatch (a
`switch`/`if` on `url.pathname`) are still off that list, so a Worker using one of those shapes
still lands at whole-file grain — there's no static route table on the Worker side for the
Telemetry Query API's `trigger` string to resolve against. itty-router and unrecognized manual
routing stay file-grain-only until a recognizer for one of them earns its own slot in the
registry, the same "coverage grows one router at a time" discipline `routes.ts` already
documents.

## Out of scope for this cut

Cron Triggers and Queue consumers (the `trigger` field's non-HTTP branch — "queue message" —
carries no path dimension to fuse on regardless of route-recognizer state), Durable Objects and
D1/KV/R2 binding-level telemetry (a different signal shape than request-triggered `fetch`
invocations), and Workers trace/span data beyond the `duration`/`statusCode` fields this
connector's fusion step reads (deeper trace shape is better served by the native OTLP export
path once a push-receiver amendment exists).
