# GCP HTTP(S) Load Balancer connector

Eleventh implementation of the [connectors plane](./README.md) (ADR-218) and the direct sibling
of the [Cloud Run connector](./cloud-run.md) ([ADR-165](../decisions.md#adr-165--the-cloud-run-connector-reads-cloud-logging-request-logs-and-fuses-onto-route-grain)):
both pull Cloud Logging's `entries.list` and fuse a request-log signal onto the `RouteNode`s
`packages/core/src/extract/routes.ts` already resolves — no app instrumentation required. Where
Cloud Run reads a `cloud_run_revision` service's own request log, this connector reads the
external Application Load Balancer's `http_load_balancer` request log, so an LB in front of a
GKE or Compute Engine backend — which emits no per-service request log of its own — still lights
up route-grain OBSERVED edges.

## Scope

- **Target: Cloud Logging `entries.list`, filtered to the external LB request log.** The global
  external Application Load Balancer writes a structured request log for every request it routes,
  on the `http_load_balancer` monitored resource, when request logging is enabled on a backend
  service. This connector pins the filter to that log (`projects/<id>/logs/requests`,
  `resource.type = "http_load_balancer"`), reading the LB's own request record and nothing else.
- **Hosting/edge-platform shape, not client-SDK shape.** Like Cloud Run and Railway, the LB names
  nothing in application code — the signal comes entirely from Google's own load-balancing
  request-logging pipeline watching traffic hit routes the backend app already declares. Fusion
  binds onto the existing `RouteNode`, the same node an OBSERVED server span would fuse onto if
  the backend were OTel-instrumented.
- **Both credential profiles ship day one.** The read grant (`roles/logging.viewer`) reaches logs
  only and never customer data, so both profiles use the same grant — the same finding Cloud Run
  and Firebase recorded, no narrower-first hosted cut.
- **Choose one connector per service path.** Where an LB fronts a Cloud Run service, both this
  connector and the Cloud Run connector observe the same requests and mint onto the same
  `RouteNode` identity, so running both against one path fuses rather than twins. Prefer this
  connector for a GKE / Compute Engine backend (which has no per-service request log), and the
  Cloud Run connector for a plain Cloud Run deployment.

## Surfaces used

### Cloud Logging `entries.list`, filtered to the LB request log (both profiles)

Every field below was confirmed against Google's own documentation rather than recalled
(ADR-150/152 — the attribute a convention names is often not the one the API returns):

- **Endpoint + envelope.** `POST https://logging.googleapis.com/v2/entries:list`, request body
  `{ resourceNames, filter, orderBy, pageSize, pageToken }`, response `{ entries, nextPageToken }`
  (`cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list`). The same surface the Cloud
  Run and Firebase connectors already poll.
- **The filter.** `poll()` queries:

  ```
  logName = "projects/<projectId>/logs/requests"
  AND resource.type = "http_load_balancer"
  AND httpRequest.requestMethod != ""
  AND timestamp >= "<since>"
  ```

  Unlike Cloud Run's `run.googleapis.com%2Frequests`, the LB log id is a plain `requests` with no
  `/` to URL-encode (`cloud.google.com/load-balancing/docs/https/https-logging-monitoring`).
- **The resource.** `http_load_balancer`, labels `backend_service_name`, `forwarding_rule_name`,
  `target_proxy_name`, `url_map_name`, `zone`, `project_id`
  (`cloud.google.com/logging/docs/api/v2/resource-list`). This connector reads
  `backend_service_name` — the backend the LB routed to, the fusion twin of Cloud Run's
  `service_name`.
- **The payload.** `httpRequest` carries `requestMethod`, `requestUrl`, `status` (integer), plus
  `latency`, `remoteIp`, `requestSize`, `responseSize`, `serverIp`, `userAgent`, `referer`
  (`cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry`). `requestUrl` on the external LB
  is typically a full absolute URL (scheme+host+path); a bare path is handled too. `protocol` is
  documented as **not** populated for `resource.type = "http_load_balancer"`, so this connector
  does not read it. The entry's `timestamp` is the request's own event time, used as
  `lastObservedIso` — never `receiveTimestamp` (ingest time).
- **Auth (both profiles).** A GCP OAuth token scoped to `roles/logging.viewer` (the
  `logging.logEntries.list` permission). A custom role holding only `logging.logEntries.list` is
  narrower still. Minting the token (a service-account key or an ADC-derived token) is a
  profile-specific broker/config concern outside this connector — `poll()` consumes an
  already-minted `accessToken`, the same way Cloud Run, Firebase, and Railway consume an
  already-minted credential.
- **Poll cadence.** On-demand for local (daemon tick / `neat sync`); a fixed interval for hosted.
  The candidate hosted value needs-endpoint-testing against `entries.list`'s live rate limits and
  Cloud Logging's own ingest latency.

## Credential + least privilege

`credentials` carries `{ projectId, accessToken }` — `projectId` names the GCP project (not a
secret; a plaintext literal is expected), `accessToken` is the short-lived read-only OAuth token
above. The connector performs no auth handshake of its own and never logs, stores, or writes the
token into a node or edge (connectors.md §6). Grant `roles/logging.viewer` (or a custom role with
only `logging.logEntries.list`) and nothing more — this connector reads request logs and reaches
no customer data.

## Fusion — node identity

A signal carries `(backend_service_name, method, path)`. Resolution runs two tiers (resolve.ts):

1. **Route grain.** `backend_service_name` maps through a config-time `backendServiceMap` to a
   NEAT service name — resolved once at setup, never guessed, since a backend service name need
   not match `package.json#name`. When the request's normalized `(method, path)` matches a
   `RouteNode` that service declares, the OBSERVED `CALLS` edge lands on that route, sharpened to
   the route's own definition file/line by the shared pipeline (`routeCallSiteFor`, ADR-143) —
   file precision drawn from the static route definition, not a runtime stamp.
2. **Backend grain, honestly.** When no static route resolves, the connector declares an honest
   `ensureInfraNode` fallback (connectors.md §4a, ADR-133): the edge lands on
   `infraId('gcp-lb-backend', <backend_service_name>)`, the LB backend as a real platform
   resource, surfacing as a `missing-extracted` divergence rather than a silent drop. The id is
   reserved so a future GCP load-balancing / backend-service extractor fuses onto it rather than
   twinning.

An entry with no `backend_service_name` (an LB-synthesized 502/503 that never reached a backend)
is dropped honestly rather than attributed to a service it never touched.

## Dedup — a timestamp watermark, no baseline

A request log is a per-request event, not a cumulative counter, so — like Cloud Run and unlike
Neon's `pg_stat_statements` — no baseline is kept: `since` advances to each tick's start and the
filter's `timestamp >= since` lower-bounds the next window. A first poll with no watermark
backfills a bounded 24h lookback, never an unbounded full-history replay.

## Static extractor gap this connector exposes

A route hit only in production, absent from the static route table, lands on the tier-2
`gcp-lb-backend` InfraNode as a `missing-extracted` divergence — exactly the observed-but-not-
declared surface the connectors plane exists to make visible. Growing `extract/routes.ts` to
recognize the backend's router is what promotes such an edge from backend grain to route grain;
no new provider telemetry is required.

## Out of scope for this cut

- **Regional external, internal, and passthrough load balancers.** These carry distinct
  monitored-resource types (`http_external_regional_lb_rule`, `internal_http_lb_rule`, the
  network-LB types). This connector reads the global external Application Load Balancer's
  `http_load_balancer` log; the others are follow-ons that add a resource type to the same fetch
  path, not a new connector.
- **A `LogEntry` side-output.** Additive per connectors.md §7; the request record maps to one
  `ObservedSignal` in this cut.
- **Any non-logging Google API surface.** This connector reads Cloud Logging and nothing else —
  no Compute, no Monitoring, no Container APIs.
