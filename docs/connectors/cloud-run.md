# Cloud Run connector

Sixth implementation of the [connectors plane](./README.md) (ADR-165), following the
hosting-platform pattern [ADR-127](../decisions.md#adr-127--the-railway-connector) established
for Railway and [ADR-128](../decisions.md#adr-128--the-firebase-connector) already applies to
`cloud_run_revision` request logs. Pulls Cloud Logging's request-log signal for a Google Cloud
Run service and fuses it onto the `RouteNode`s `packages/core/src/extract/routes.ts` already
resolves — no app instrumentation required, since Cloud Run writes a structured request log for
every request on its own.

## Scope

- **Target: Cloud Logging `entries.list`, filtered to the Cloud Run request log.** Cloud Run
  is a general serverless host, not a Firebase surface. Firebase's connector (ADR-128) already
  reads `cloud_run_revision` request logs, but only for services a Firebase project deployed,
  and it filters by resource type without pinning the log name — so it also sweeps whatever an
  app writes to stdout/stderr on the same resource. This connector pins the filter to Cloud
  Run's own request log (`run.googleapis.com/requests`), reading the request record and nothing
  else. The two connectors mint onto the same `RouteNode` identity, so configuring both against
  one project fuses rather than twins.
- **Hosting-platform shape, not client-SDK shape.** Like Railway, Cloud Run names nothing in
  application code — the signal comes entirely from Google's own request-logging pipeline
  watching traffic hit routes the app already declares. Fusion binds onto the existing
  `RouteNode`, the same node an OBSERVED server span would fuse onto if the app were
  OTel-instrumented.
- **Both credential profiles ship day one.** The read grant (`roles/logging.viewer`) reaches
  logs only and never customer data, so there is no Fork-A-style gap where the hosted profile
  must ship a narrower cut first (`supabase.md` §Scope's log-surface-only sequencing has no
  equivalent here) — both profiles use the same grant.

## Surfaces used

### Cloud Logging `entries.list`, filtered to the Cloud Run request log (both profiles)

Cloud Run writes a structured request log for every request served, carrying a full
`httpRequest` object — method, URL, status, latency — on the `cloud_run_revision` monitored
resource, and it does so automatically with no logging agent and no app change. Every field
below was confirmed against Google's own documentation rather than recalled (ADR-150/152 — the
attribute a convention names is often not the one the API returns):

- **Endpoint + envelope.** `POST https://logging.googleapis.com/v2/entries:list`, request body
  `{ resourceNames, filter, orderBy, pageSize, pageToken }`, response `{ entries, nextPageToken }`
  (`cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list`).
- **The filter.** `poll()` queries:

  ```
  logName = "projects/<projectId>/logs/run.googleapis.com%2Frequests"
  AND resource.type = "cloud_run_revision"
  AND httpRequest.requestMethod != ""
  AND timestamp >= "<since>"
  ```

  The `/` inside the log id is URL-encoded `%2F`, and the filter carries that encoded form
  (`cloud.google.com/run/docs/logging`, cross-checked against a live project's exported logs).
- **The resource.** `cloud_run_revision`, labels `project_id`, `service_name`, `revision_name`,
  `location`, `configuration_name` (`cloud.google.com/logging/docs/api/v2/resource-list`). This
  connector reads `service_name`.
- **The payload.** `httpRequest` carries `requestMethod`, `requestUrl`, `status` (integer), plus
  `latency`, `remoteIp`, `requestSize`, `responseSize`, `serverIp`, `userAgent`, `referer`
  (`cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry`). `requestUrl` is documented as
  "typically without the scheme, host, port, and query portion" — usually already a bare path;
  a full absolute URL is handled too. The entry's `timestamp` is the request's own event time,
  used as `lastObservedIso` — never `receiveTimestamp` (ingest time).
- **Auth (both profiles).** A GCP OAuth token scoped to `roles/logging.viewer` (the
  `logging.logEntries.list` permission). A custom role holding only `logging.logEntries.list` is
  narrower still. Minting the token (a service-account key or an ADC-derived token) is a
  profile-specific broker/config concern outside this connector — `poll()` consumes an
  already-minted `accessToken`, the same way Firebase and Railway consume an already-minted
  credential.
- **Poll cadence.** On-demand for local (daemon tick / `neat sync`); a fixed interval for
  hosted. The candidate hosted value needs-endpoint-testing against `entries.list`'s live rate
  limits and Cloud Logging's own ingest latency.

## Credential + least privilege

The credential is `{ projectId, accessToken }`:

- `projectId` is not a secret — a plaintext literal in `connectors.json` is expected (it names
  the GCP project, not a token).
- `accessToken` is a short-lived OAuth token minted from a service-account key or ADC, scoped to
  **`roles/logging.viewer`** and nothing else. Grant that role at the project level to the
  service account the token belongs to, and **revoke every other grant** on that account — the
  connector needs `logging.logEntries.list` and no write, no data-plane, no admin permission. A
  custom role carrying only `logging.logEntries.list` is the narrowest workable grant.

The token is read from `ConnectorContext.credentials` at poll time, never logged, never written
into a node or edge (`connectors.md` §6). Its env-ref lives in `connectors.json`; the value is
resolved only at daemon-read time (`connector-config.md` §2).

## Fusion — node identity

Fusion targets the existing `RouteNode`, the same hosting-platform-fusion pattern ADR-127
established for Railway and ADR-128 for Firebase. No new `NodeType`. Resolution runs in two
tiers:

- **Route grain (the fused win).** The GCP `service_name` maps through a config-time `serviceMap`
  (`{ "<gcp-service-name>": "<neat-service-name>" }`) to a NEAT service name — supplied once at
  connector setup, the "resolved once, never guessed" discipline ADR-127 states for Railway,
  since a Cloud Run service name need not match `package.json#name`. When the request's
  normalized `(method, path)` matches a `RouteNode` that service already declares, the connector
  mints a file-grained OBSERVED `CALLS` edge onto it — sharpened to the route's own definition
  file/line, because the RouteNode records that site and the shared pipeline reconciles onto it
  (ADR-143). This file precision comes from the **static** route definition, not a runtime
  `code.*` stamp.
- **Service grain, honestly (the missing-extracted divergence).** When no static route resolves —
  the app's router isn't one `routes.ts` recognizes yet, or the path matches no declared template
  — the connector does not fabricate a route. It declares an honest fallback via `ensureInfraNode`
  (`connectors.md` §4a, ADR-133): the edge lands on `infraId('cloud-run-service', <service_name>)`,
  the Cloud Run service as the real platform resource its own log names, surfacing as a
  `missing-extracted` divergence — production traffic the codebase's static route table doesn't
  account for — instead of a silent drop. An unmapped `service_name` sources the edge from the
  Cloud Run service's own name, so a connector added before the `serviceMap` is filled is never
  silent; it just stays coarse until the map lands.

**The honest ceiling.** Route/service grain is the correct ceiling here, and file precision (tier
1) comes only from a matched route's static definition site. An un-instrumented host emits no
`code.*` call-site telemetry, so there is no runtime file grain to reach — and there cannot be
until an app instruments itself and pushes OTLP, at which point the OBSERVED span fuses onto the
very same `RouteNode` this connector already targets.

## Dedup — a timestamp watermark, no baseline

A Cloud Run request log is a per-request event, not a cumulative counter (unlike Neon's
`pg_stat_statements`), so no baseline is kept. `since` advances to each tick's start; the filter's
`timestamp >= since` lower-bounds the next window. A first poll with no watermark backfills a
bounded 24h lookback (`connectors.md` "Poll cadence and backfill"), never an unbounded full-history
replay.

## Static extractor gap this connector exposes

None new, in the sense `supabase.md` documents one: `routes.ts` already parses the route shapes a
Cloud-Run-hosted app declares (Express, Fastify, Next.js). The gap that does exist is `routes.ts`'s
own framework coverage — an app on a router `routes.ts` doesn't recognize yet gets tier-2
service-grained edges, the same honest fallback any unrecognized framework already produces for
OTel-derived route fusion. That gap belongs to `routes.ts`, not to this connector. The
`infra:cloud-run-service:<name>` fallback id is also chosen so a *future* Cloud Run service-manifest
extractor (the analog of Cloudflare's `extract/infra/cloudflare.ts`) fuses onto the same node rather
than twinning it.

## Out of scope for this cut

Cloud Run **job** logs and container stdout/stderr logs — this connector reads request logs only
(`run.googleapis.com/requests`), the runtime-traffic surface; a job execution or an app's own log
line is a different question. Native OTel emission — Google Cloud is an OTel sink, not a source;
an app that wants push-based traces still instruments and exports itself, same as any other
unobserved app, and this connector's pull path is what closes the gap for apps that haven't.
Cloud Logging ingest latency — a request logged just before a tick's watermark can become
queryable just after it, so the `timestamp >= since` window can miss such a straggler; widening
the window would risk double-counting an event across two ticks, so the watermark stays
honest-and-simple, the same trade Firebase's connector makes against the same API.
