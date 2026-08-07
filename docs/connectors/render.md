# Render connector

A pull provider on the [connectors plane](./README.md) (ADR-124, ADR-166). Render (render.com) is
a popular indie/startup host. This connector pulls Render's own edge-layer HTTP request logs and
mints OBSERVED edges fused onto the `RouteNode`s `packages/core/src/extract/routes.ts` already
builds — no app instrumentation required, and no client SDK to recognize, because a Render-hosted
app's routes simply run behind Render's edge. It is the second route-fusion connector, after
Railway (ADR-127).

## Why pull, not a drain

The connectors plane has two shapes: a Vercel-style push/drain that reuses the daemon's OTLP
receiver (ADR-146), and a Railway-style pull (ADR-127). Render's telemetry surface was checked
against Render's own docs before choosing, and only the pull path reaches NEAT's OBSERVED layer:

- **Log streams** (`render.com/docs/log-streams`) forward logs to a TLS syslog endpoint over TCP in
  RFC5424 format (Datadog, Better Stack, Papertrail, or another syslog/HTTPS drain). That is syslog,
  not OTLP — it never arrives at the daemon's `/v1/traces` receiver, so a drain here would require a
  new syslog receive path, which the drain shape exists specifically to avoid.
- **Metrics streams** (`render.com/docs/metrics-streams`) forward service metrics (memory, CPU,
  disk) as OTLP to a Pro-plan-or-higher observability provider. That is OTLP, but *metrics*, not
  spans — NEAT's OBSERVED edges come from spans, so a metrics stream produces no edge.
- **The REST API** (`api-docs.render.com/reference/list-logs`) exposes `GET /v1/logs`, which returns
  the edge-layer HTTP request logs a Pro workspace already generates.

Render has no OTLP trace-drain to point a push connector at, so it joins the pull registry.

## Scope

- **Target: Render's REST API only.** Render is SaaS-only — there is no self-hosted Render product,
  so unlike Supabase there is no Cloud-vs-self-hosted branch to resolve and none expected later.
- **Hosting-platform shape, not client-SDK shape.** Render names nothing in application code; the
  signal comes entirely from Render's own edge layer watching traffic hit routes the app already
  declares. Fusion binds onto the `RouteNode` static extraction produces, the same way Railway's
  `httpLogs` does.
- **Credential: a Render API key (Bearer).** Created from Render's account settings
  (`render.com/docs/api`). This is the honest least-privilege limit for the hosted profile
  (`connectors.md` §3): Render does not offer a granularly-scoped or read-only key — a key grants
  access to every workspace the user belongs to (`render.com/docs/api`, and Render's own "A Sandbox
  Doesn't Constrain an API Key"). The connector only ever issues read GETs (`/v1/services` to
  validate, `/v1/logs` to poll), but the token itself cannot be narrowed to that grant. The local
  profile uses the developer's own key; the hosted profile carries the broadest cut Render's auth
  model allows until Render exposes something narrower.

## Surface used

### `GET /v1/logs?type=request` — route-grain signal

Render's REST API exposes the edge-layer HTTP request log: a structured per-request record generated
by Render's own edge, independent of whatever the app writes to stdout. The query is scoped by the
workspace `ownerId` and the service `resource` id (both required), filtered to `type=request`,
windowed by `startTime`/`endTime`, and paginated by timestamp cursors (`hasMore` plus
`nextStartTime`/`nextEndTime`). Each entry carries a `timestamp`, a `message`, and a `labels` array;
a request log's `method`, `path`, `statusCode`, and `host` live in those labels — enough to
reconstruct one HTTP call's shape without any app-side change.

- **Auth:** a Bearer API key (`Authorization: Bearer <token>`). Render is a plain REST API, so a
  live key returns 2xx and a bad one 401/403 — `neat connector add` validates with a cheap
  `GET /v1/services?limit=1` round-trip, with none of Railway's GraphQL-in-200 auth trap.
- **Bounded lookback + pagination:** a first poll (or a gap wider than the window) backfills from
  `now - maxLookbackMs` (a conservative 24h default), never an unbounded full-history replay, and a
  single tick follows the cursor pagination up to a bounded page count so a busy service can't stall
  a poll (`connectors.md` §"Poll cadence and backfill").
- **Poll cadence:** on daemon tick / the connector's own poll loop for local; a fixed interval for
  hosted.

## Fusion — node identity

No new `NodeType`. Like Railway, Render targets the `RouteNode` `routes.ts` already extracts
(ADR-119) — the same node an OBSERVED server span would fuse onto if the app were OTel-instrumented.

**Route-grain fusion (request log → `RouteNode`).** The connector reads a request log's method and
path from its `labels`, strips any query string, normalizes the path with the same
`normalizePathTemplate` the static side uses, and matches against the polled service's own
RouteNodes. A match mints a file-grained OBSERVED `CALLS` edge onto that RouteNode, reconciled onto
the EXTRACTED service-relative path via the RouteNode's own recorded `path`/`line` — the ingress-
target file-graining every route-targeting connector shares (`connectors.md` §4, ADR-143). When no
RouteNode resolves — the app's framework/router isn't one `routes.ts` recognizes yet, or the path
matches no declared template — the observation stays an honest `unmatched-route` signal that
resolves to nothing rather than fabricating a RouteNode, whose `path` is a required real source
location (`file-awareness.md` §6). That is the same `missing-extracted` divergence surfacing every
other connectors-plane and OTLP-ingest surface produces when static coverage falls short of observed
traffic.

**Service identity mapping.** Render names a service by its own `srv-...` id, which will not
generally match NEAT's manifest-derived `serviceId(name)` — the two are different naming authorities
with no shared source of truth. The connector takes an explicit `serviceName` at setup (the NEAT
manifest name that owns the RouteNodes), supplied once, never inferred from a Render API response.

## Grain — honestly coarse

The grain is route/service, not file. An un-instrumented host carries no `code.*` call site of its
own, so this connector file-grains only as far as the RouteNode's own recorded definition site
allows — it never guesses a finer grain than the request log supports, and never mints a `code.*`
file-grain the host didn't emit. Sharpening comes from `routes.ts` growing new framework coverage
(so more observed paths resolve to a declared route), not from any Render-specific telemetry, and
none exists that would carry a finer grain.

## What is verified

The surface, the endpoint (`GET /v1/logs`), the required parameters (`ownerId`, `resource`,
`type=request`), the timestamp-cursor pagination (`hasMore` / `nextStartTime` / `nextEndTime`), the
Bearer auth, and the request-attribute names (`method` / `statusCode` / `path` / `host`) are sourced
from Render's public API docs (`api-docs.render.com/reference/list-logs`, `render.com/docs/logging`,
`render.com/docs/log-streams`, `render.com/docs/api`), not from a live authenticated introspection —
this connector has no Render account to probe against.

What remains unconfirmed pending a live project, and how the connector handles it:

- **Label vs top-level layout.** The docs describe request attributes as filterable and carry a
  `labels` array on each entry; whether every attribute is a label (as modeled here) versus a
  top-level field on a real response is not confirmed. The mapping layer reads the attributes from
  `labels` and drops a row honestly when they're absent rather than guessing — so a layout mismatch
  degrades to zero signals, never to a fabricated edge.
- **Retention window.** Request-log retention varies by Render plan and isn't published as a single
  number; the 24h default lookback is a conservative chosen value, overridable once a live project
  confirms the real cap.
- **Rate limit.** Render's per-key rate limit isn't pinned here to a confirmed number; the junction
  bucket (ADR-131) is a conservative placeholder, matching the other pull providers.

This is the same discipline `railway.md` kept before its own live check (#738) confirmed its guessed
field names.

## Out of scope for this cut

- **App and build logs.** `type=request` is the only surface read — app and build logs are
  free-text stdout with no structured route to bind to.
- **Metrics and syslog streams.** Neither reaches the OBSERVED layer (see "Why pull, not a drain"),
  so this connector observes request traffic, not everything Render can emit.
- **Native OTel/APM ingestion.** The only path to a Render trace is the app bringing its own OTel
  exporter — an app-side OTLP push NEAT already ingests today, not a connectors-plane concern.
