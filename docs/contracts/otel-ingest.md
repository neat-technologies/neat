---
name: otel-ingest
description: OTel receiver replies before mutation, lastObserved derives from span time, parent-span cache correlates cross-service CALLS, exception data is parsed from span events, unseen services and DBs are auto-created, queue producers and consumers mint file-grained messaging edges to the destination topic, GraphQL execution spans mint an operation-grain CONTAINS edge, gRPC execution spans mint a method-grain CONTAINS edge, WebSocket upgrade spans mint a channel-grain CONNECTS_TO edge, span-derived edges always carry OBSERVED provenance, the same edge-minting primitives serve pull-based connector signals, a sibling /v1/logs receiver feeds the logs surface without touching the graph.
governs:
  - "packages/core/src/ingest.ts"
  - "packages/core/src/otel.ts"
  - "packages/core/src/otel-grpc.ts"
  - "packages/core/src/otel-logs.ts"
adr: [ADR-033, ADR-113, ADR-117, ADR-118, ADR-121, ADR-122, ADR-123, ADR-124, ADR-125, ADR-132, ADR-029, ADR-030, ADR-068]
enforcement: [lint, review]
---

# OTel ingest contract

The first of three v0.2.2 producer-layer contracts. Governs the OTel ingest path: receiver, span parsing, the `handleSpan` mutation function. Sibling contracts: [trace-stitcher.md](./trace-stitcher.md), [frontier-promotion.md](./frontier-promotion.md). Together they lock the OBSERVED layer.

## Non-blocking ingest (binding)

The HTTP receiver replies 200 OK as soon as the body is parsed. Mutation runs through an in-process queue drained on the next tick. **The OTel sender is never blocked on graph mutation.** SDK exporters retry on timeout, so blocking ingest would produce observable backpressure on the system being observed; ambient observation requires no observable effect.

Issue #131 closed this with a chained-Promise drain loop. Errors in `onSpan` log and continue rather than killing the loop. `flushPending()` is exposed on the receiver as a test seam; production code never awaits it.

The receiver awaits exactly one synchronous step before reply: `onErrorSpanSync` for spans with `statusCode === 2`, so error-event durability is preserved (see §Error events). gRPC ingest still awaits `onSpan` inline — non-blocking gRPC is deferred.

## `lastObserved` from span time

Every OBSERVED edge's `lastObserved` field is derived from `span.startTimeUnixNano`, converted to ISO8601. Replayed traces, out-of-order spans, and historical fill-ins must produce a `lastObserved` that reflects when the span actually fired — not when the receiver received it.

The conversion lives in `parseOtlpRequest` so every consumer of `ParsedSpan.startTimeUnixNano` gets a normalized form. `nowIso(ctx)` is for cases where a span timestamp doesn't apply (e.g. ad-hoc test fixtures); production paths use the span time. Issue #132 closes this gap.

## Parent-span cache for cross-service CALLS

Today peer resolution uses `server.address` / `net.peer.name` / `url.full` only. That misses non-HTTP RPCs and any span whose peer is opaque.

The contract adds a bounded TTL cache keyed by `${traceId}:${spanId}` storing each span's service. On span arrival:

1. Address-based resolution runs first (`pickAddress(span)`).
2. If no peer is found and `parentSpanId` is set, look up the parent in the cache. If the parent's service is known and differs from the current span's service, that's a cross-service CALLS edge.

Cache size and TTL are constants near the other ingest tunables. Out-of-order arrival (child before parent) drops the child; we don't buffer. Issue #133.

## Auto-creation of unseen services and databases

When `handleSpan` resolves a `service.name` not present in the graph, it creates a minimal `ServiceNode` at `serviceId(span.service)` with `language: 'unknown'`, no `version`, no `dependencies`. Same for unseen `db.system` + host — a minimal `DatabaseNode` at `databaseId(host)`.

Auto-created nodes carry `discoveredVia: 'otel'` (schema growth governed by ADR-031 — adds an optional field, snapshot regenerates).

When static extraction later finds the same id, attributes **merge** per ADR-028 §3. Static fields override OTel-derived fields where both exist (because static is more authoritative on declared intent: language, version, dependencies). `discoveredVia` becomes `'merged'` if both layers recorded the node independently. Issue #134.

## In-process databases mint a file-grained `CONNECTS_TO` edge (ADR-118, refs #576 / #546)

A `db.system` span carries the datastore relationship whether or not the datastore is across the network. A networked database — Postgres, a remote Redis — carries a peer address, and its `CONNECTS_TO` OBSERVED edge points at `databaseId(host)`. An in-process / embedded database — SQLite, better-sqlite3, an in-memory store — crosses no network boundary and carries no peer address, so it mints the same edge keyed on a **service-scoped local identity**: `localDatabaseId(span.service, name)` → `database:<service>/<name>`, where `name` is the span's `db.name` when present and the engine string (`db.system`) otherwise. Service-scoping keeps two services that each read their own `app.db` on distinct nodes rather than collapsing onto one. The local `DatabaseNode` records **no `host`** — an embedded database has no network host, and evidence is never fabricated (file-awareness.md §6); a host-less `DatabaseNode` is cleanly skipped by host-mismatch divergence.

Both edges are **file-grained** through the same call-site path as any other OBSERVED edge (file-awareness.md §4): when the span processor stamped `code.*` on the synchronous DB CLIENT span, the edge originates from the caller's `FileNode` at the exact `file:line`, reconciled onto the EXTRACTED service-relative path (`reconcileObservedRelPath`) so the OBSERVED and EXTRACTED layers fuse into one node. A DB span with no call site stays service-level, honestly. The caller-side gate (`spanMintsObservedEdge`) applies unchanged; the in-process edge is minted only from the caller/producer side, never fabricated from an INTERNAL connection span.

The inbound-server liveness edge and the GraphQL / gRPC / WebSocket and non-DB in-process boundaries remain deferred to #576's later cuts.

## MongoDB spans mint a collection-grain edge (ADR-148, ADR-150, refs #832)

A MongoDB span carries the *collection* it operated on, one grain finer than the database node the `CONNECTS_TO` edge above lands on. Two instrumentations produce these spans, and they disagree on `db.system` — the ingest accepts **both `db.system: mongodb` and `db.system: mongoose`** (ADR-150). This matters because, on current driver versions, the raw `@opentelemetry/instrumentation-mongodb` emits only connection spans (no command span, no collection), while `@opentelemetry/instrumentation-mongoose` — the one that actually fires for a mongoose app, NEAT's primary target — emits `mongoose.<Model>.<op>` spans under `db.system: mongoose`. Both set the collection as `db.collection.name` (stable convention) or `db.mongodb.collection` (older). When either `db.system` value is present alongside a collection attribute, the span mints an OBSERVED edge to `infra:mongodb-collection:<name>`, the collection node one layer below `database:mongodb:<host>` — the same node id `calls/mongoose.ts` (ADR-147) emits statically, so the observed edge fuses onto the file→collection call site rather than twinning it. The collection name is read straight off the span (`db.collection.name` first, fall back to `db.mongodb.collection`); it is not derived, so the span's collection is ground truth where the extractor's Mongoose-pluralized derivation is quirk-wrong or unresolved. A MongoDB/mongoose span with no collection attribute mints only the database-grain `CONNECTS_TO` edge, as before — the collection edge is additive, never a replacement.

## SQL spans mint a table-grain edge (ADR-152, refs #796)

A SQL span carries the *table* it operated on, one grain finer than the `database:<host>` node the `CONNECTS_TO` edge lands on — but, unlike the mongoose case, the SQLAlchemy and raw dbapi/psycopg instrumentations emit **no table attribute**. `db.sql.table` and `db.collection.name` are never set; the table lives only in the `db.statement` SQL text (verified against a live instrumented app — ADR-152). So `parseOtlpRequest` recovers it with `tableFromSqlStatement`: the single identifier after `FROM` / `INTO` / `UPDATE`, quote- and schema-stripped, degrading to `undefined` on a joined or multi-`FROM` (subquery) statement rather than guessing. When a table resolves, the span mints an OBSERVED `CALLS` edge to `infra:sql-table:<name>` — the engine-agnostic table node `extract/calls/sqlalchemy.ts` (ADR-151) also produces from the model's declared/derived table — so the declared and observed table access fuse onto one node rather than twinning. The engine stays on the `database:<host>` node one layer up (ADR-141); the table edge is additive, never a replacement for the database-grain `CONNECTS_TO`. It is file-grained through the same call-site path as any other OBSERVED edge, and service-level otherwise, honestly.

## Queue producers and consumers mint file-grained messaging edges (ADR-121, refs #614)

A messaging span carries its **topic / queue / stream** as the thing the code talks to — the broker host is transport, not the destination. `handleSpan` reads the messaging semconv (`messaging.system` and `messaging.destination.name`, with the legacy `messaging.destination` as fallback) and mints an OBSERVED edge to the destination node: a **PRODUCER** span (wire kind 4) mints `PUBLISHES_TO`, a **CONSUMER** span (wire kind 5) mints `CONSUMES_FROM`. Both are the observed mirror of the static extractor's messaging edges — the queue-side pair of directions, so declared and observed queue topology fuse rather than twin.

The destination node is keyed **identically to the static extractor** so the OBSERVED and EXTRACTED edges land on one node: the static Kafka side names its topic `infra:kafka-topic:<topic>` (`extract/calls/kafka.ts`), so the node kind is `<messaging.system>-topic` — `kafka` → `kafka-topic` — and the same shape generalises to every messaging system the semconv names (Redis Streams, and beyond). The node carries `provider: 'self'`, matching the static extractor's non-AWS provider, so an observed-first destination merges cleanly when static analysis later reaches the same topic.

The edge is **file-grained** through the same call-site path as any other OBSERVED edge (file-awareness.md §4): when the span carries `code.*`, the edge originates from the producer's / consumer's `FileNode` at the exact `file:line`, reconciled onto the EXTRACTED service-relative path (`reconcileObservedRelPath`, ADR-118) so the OBSERVED and EXTRACTED layers fuse into one edge grain — the same `(source, target, type)` the static `PUBLISHES_TO` / `CONSUMES_FROM` uses. A messaging span with no call site stays service-level, honestly. The messaging gate (`spanMintsMessagingEdge`) admits only PRODUCER and CONSUMER kinds, and only when the span actually names a destination — a destination-less consumer span (the ADR-117 worker-incident shape) mints no edge, and a CONSUMER span never mints a spurious service-level `CALLS`.

## GraphQL execution spans mint an operation-grain `CONTAINS` edge (ADR-122, refs #615)

Every GraphQL request rides one HTTP endpoint — `POST /graphql` — so at HTTP grain the whole API collapses to a single edge and the operation-level topology is invisible. The GraphQL execution span carries the operation the client actually named: `handleSpan` reads `graphql.operation.name` and `graphql.operation.type` (`query` / `mutation` / `subscription`) and mints an OBSERVED `CONTAINS` edge from the serving service to a per-operation `GraphQLOperationNode`, recovering the topology HTTP grain flattens.

The operation node is keyed on `graphqlOperationId(service, operationType, operationName)` → `graphql:<service>:<type> <name>` (identity.md), with `operationType` normalised lower-case so `query` and `Query` land on one node. The ownership edge is `CONTAINS` — the same structural verb a service has over a route (ADR-119) and a file (file-awareness.md §2) — carrying OBSERVED provenance. The node is minted **observed-first**: this cut does **not** parse the GraphQL SDL or resolver map statically, so the node's identity is chosen so a future static GraphQL extractor fuses onto the same id rather than twinning.

The edge is **file-grained** through the same call-site path as any other OBSERVED edge (file-awareness.md §4): when the execution span carries `code.*` (the resolver call site), the edge originates from that `FileNode` at the exact `file:line`, reconciled onto the EXTRACTED service-relative path (`reconcileObservedRelPath`, ADR-118); without a call site it stays service-level, honestly. The GraphQL gate (`spanServesGraphqlOperation`) admits only the serving side — SERVER / INTERNAL / unkinded spans — and only when the span names **both** an operation name and type: a CLIENT/PRODUCER/CONSUMER span mints nothing (client-side operation attribution is deferred), and a nameless or typeless execution span falls through rather than keying a fabricated operation.

Deferred: resolver / field-grain edges, static GraphQL schema extraction, and client-side operation attribution.

## gRPC execution spans mint a method-grain `CONTAINS` edge (ADR-123, refs #616)

gRPC used to engage only at service grain: every RPC method collapsed onto one service→service edge, so the per-method topology was invisible, and it was one-sided — nothing read the `.proto` service contract. The serving span carries the method the caller actually invoked: `handleSpan` reads `rpc.service` (the fully-qualified `orders.OrderService`) and `rpc.method` (`GetOrder`) under `rpc.system=grpc` and mints an OBSERVED `CONTAINS` edge from the serving service to a per-method `GrpcMethodNode`, recovering the method-level shape the service-grain edge flattens.

The method node is keyed on `grpcMethodId(rpcService, rpcMethod)` → `grpc:<rpcService>/<rpcMethod>` (identity.md). Unlike the route / GraphQL-operation ids, it keys on the **fully-qualified `rpc.service`, not the NEAT manifest service name** — that FQN is the wire contract both the OBSERVED span and the static `.proto` carry verbatim, and it is globally unique across a gRPC mesh, so keying on it is exactly what fuses the observed method and its declared `.proto` definition onto one node. The ownership edge is `CONTAINS` — the same structural verb a service has over a route (ADR-119), a GraphQL operation (ADR-122), and a file (file-awareness.md §2) — carrying OBSERVED provenance; the implementing service's ownership is that edge, not part of the node identity.

The edge is **file-grained** through the same call-site path as any other OBSERVED edge (file-awareness.md §4): when the serving span carries `code.*` (the handler call site), the edge originates from that `FileNode` at the exact `file:line`, reconciled onto the EXTRACTED service-relative path (`reconcileObservedRelPath`, ADR-118); without a call site it stays service-level, honestly. The gRPC gate (`spanServesGrpcMethod`) admits only the serving side — SERVER / INTERNAL / unkinded spans — and only when `rpc.system` is `grpc` and the span names **both** a service and a method: a CLIENT span mints no ownership (client-side attribution is deferred) and instead falls through to the cross-service resolver, so the caller→callee edge is unaffected; a non-gRPC `rpc.system` (Thrift, Connect) falls through.

The static half — `.proto` service/method extraction minting the same nodes — lives in [static-extraction.md](./static-extraction.md); the two provenances fuse into a method-grain divergence.

Deferred: client-side method attribution, `grpc.status_code` / error-detail enrichment on incidents, and `.proto` `import` resolution across files.

## WebSocket upgrade spans mint a channel-grain `CONNECTS_TO` edge (ADR-125, refs #617)

A WebSocket app used to produce no OBSERVED topology at all: only message-handler errors surfaced, as incidents, and the channels themselves stayed invisible — the frames after the handshake ride the socket, not more spans. The one span that reliably marks a channel is the HTTP upgrade that opens it: a SERVER `GET` carrying `Upgrade: websocket` and the connection path. `otel.ts` derives `websocketChannel` off that span — the upgrade request header (`http.request.header.upgrade` naming `websocket`, array- or string-valued) gates it, and the path is the templated `http.route` when present, else `url.path` / `http.target` with any query string trimmed. `handleSpan` reads it and mints an OBSERVED edge from the serving service to a per-channel `WebSocketChannelNode`.

The channel node is keyed on `websocketChannelId(service, channel)` → `ws:<service>:<channel>` (identity.md). Like the route / GraphQL-operation ids and unlike the gRPC id, it is **scoped to the serving service's manifest name**: a WS path (`/chat`, `/socket.io`) carries no package qualifier and is not unique across a mesh, so the serving service disambiguates it exactly as it does a route path. The node is minted **OBSERVED-only**: a WebSocket channel is known from observation, never from static extraction, so — unlike RouteNode / GraphQLOperationNode / GrpcMethodNode — it has no declared twin to fuse with, and `path` / `line` stay absent, never fabricated (file-awareness.md §6).

The edge **reuses the existing `CONNECTS_TO`** — the same connection verb a service has to a datastore (ADR-118, #576) — **not a new edge type**. Unlike the structural `CONTAINS` a service has over a route / operation / method — durably declared artifacts whose edge never goes stale — a channel's whole meaning is liveness, so `CONNECTS_TO` is the honest shape: the edge carries `lastObserved` and **decays OBSERVED → STALE on `CONNECTS_TO`'s own staleness threshold** (no new threshold) when the channel goes quiet, via the daemon staleness loop (#532). It is **file-grained** through the same call-site path as any other OBSERVED edge (file-awareness.md §4): when the upgrade span carries `code.*` the edge originates from that `FileNode` at the exact `file:line`, reconciled onto the EXTRACTED service-relative path; without a call site it stays service-level, honestly. The WebSocket gate (`spanServesWebsocketChannel`) admits only the serving side — SERVER / INTERNAL / unkinded spans — so a CLIENT upgrade span mints no channel (client-side attribution is deferred).

## SERVER spans mint a route-grain `CONTAINS` edge (refs #576)

An inbound HTTP `SERVER` span names the route it served in `http.route` (the templated path the router matched, `/users/{id}`) and the method in `http.request.method` (falling back to the legacy `http.method`). `handleSpan` matches that `(method, template)` against the statically-extracted `RouteNode` for the service — by `normalizePathTemplate`, so param-syntax differences across frameworks (`{id}` vs `:id` vs `<int:id>`) don't block the match — and mints an OBSERVED `CONTAINS` edge from the serving service to that route, the same structural verb and observed-serving shape GraphQL operations (ADR-122) and gRPC methods (ADR-123) use. This fuses a declared route with its observed traffic, so `get_divergences` compares declared against served at route grain. A route NEAT never extracted has no declared twin to land on, so it mints nothing here — the served-but-undeclared route stays a follow-on, and no observed-only RouteNode is fabricated. Only the serving side (`SERVER` / unkinded) is admitted: a CLIENT span carries `url` / `http.target`, not the served `http.route`, and mints nothing.

## A sibling `/v1/logs` receiver feeds the logs surface, never the graph (ADR-132)

Every receiver above this point turns a span into a graph mutation. `packages/core/src/otel-logs.ts` is a structurally different receiver: it accepts the OTLP **logs** signal (`ExportLogsServiceRequest`, JSON and protobuf, the same content-type dispatch `otel.ts` already does for traces) and produces `LogEntry` records for the bounded logs store (`logs.md`) — it never touches `NeatGraph`, mints no node, mints no edge. The non-blocking-receiver discipline (§Non-blocking ingest) and the bearer-token gate (`NEAT_OTEL_TOKEN`) apply identically; only the destination differs.

Each `LogRecord` maps to a `LogEntry` (`source: 'native'`): `timeUnixNano` → `timestamp`, `severityNumber`/`severityText` → a normalized `severity`, `body` → `message`, `resource.service.name` → `serviceName`, and — when present — `attributes['code.filepath']`/`code.lineno` → an optional call-site and `trace_id`/`span_id` → a cross-reference back to the trace that produced it. A log record naming a `service.name` NEAT hasn't seen auto-creates nothing on its own — unlike a span, a log entry never mints or resolves a `ServiceNode`; it only attaches to one if a matching `ServiceNode` already exists.

Reaching real application output requires installer wiring beyond the receiver: a logs-export counterpart to the four-deps invariant (`sdk-logs`, `exporter-logs-otlp-http`, a `LoggerProvider`) plus, for the target app, a log-library auto-instrumentation package (`instrumentation-winston` / `-pino` / `-bunyan`) when one of those libraries is in use. Bare `console.log` calls are **not** captured — no standard OTel console-capture instrumentation exists, and patching the global console is out of scope for this cut. "Native logs" means structured-logger output or explicit OTel Logs API calls, not literally everything a process ever printed; this is a stated limitation, not an oversight.

Because the channel node is OBSERVED-only by design, its OBSERVED-only `CONNECTS_TO` is **excluded from `missing-extracted`** — there is no static twin it should diverge against (see [divergence-query.md](./divergence-query.md)).

Deferred: client-side channel attribution, per-message / event-grain topology, and static WebSocket route extraction.

## Connector-sourced OBSERVED edges share the same minting path (ADR-124, refs #653)

Every edge above this point is span-derived — an OTel span arriving over OTLP. A connector (`connectors.md`) mints OBSERVED edges from a different source: a provider's own server-side telemetry, pulled rather than pushed, with no span involved at all. A connector signal still ends at the same primitive every span-derived edge does — `upsertObservedEdge`, writing the same `signal` block (`spanCount`, `errorCount`, `lastObservedAgeMs`) and the same graded confidence — so a table read counted by Supabase's Management API log query and a DB query counted by an in-process span both look identical to traversal, divergence, and the staleness loop. `lastObserved` still derives from the provider's own event time, not from poll-arrival time, mirroring the span-time rule above. File-grain reconciliation (`reconcileObservedRelPath`) applies identically when the connector's provider-specific mapping layer resolves a signal to a call site; without one, the edge lands service-level or provider-node-level, honestly, the same fallback every other OBSERVED edge in this contract takes.

What's provider-specific — fetching the signal, resolving a `(target, callCount, lastObserved)` tuple to a node id — is out of scope for this contract and lives in `connectors.md` plus each provider's own module. This section exists only to name the seam: connector code calls the same shared mutation primitives `handleSpan` calls, rather than routing observed edges through a second, parallel mechanism.

## OBSERVED provenance for span-derived edges (ADR-068)

Every edge created from an OTel span carries `provenance: 'OBSERVED'`, regardless of whether the peer resolves to a known service. The OTel span is direct observation; the target's resolution status is a separate fact about the target node, not about how the edge was learned.

- **Peer resolves to a known service:** edge id is `observedEdgeId(sourceId, targetServiceId, type)`, target is the typed-node id.
- **Peer does not resolve:** the receiver creates a FrontierNode placeholder (`frontierId(host)`) and the edge id is `observedEdgeId(sourceId, frontierNodeId, type)`. Target string starts with `frontier:`; provenance stays OBSERVED.

Both paths go through `upsertObservedEdge`, which writes the `signal` block (`spanCount`, `errorCount`, `lastObservedAgeMs`) and the graded confidence per ADR-066. The OBSERVED layer is uniform across resolved and unresolved peers — divergence queries weight both the same way, traversal stops at the FrontierNode by node-type per Rule 3.

## Exception data from span events

`OtlpSpan` is extended with `events: Array<{ name, timeUnixNano, attributes }>`. When a span has an `events[]` entry with `name === 'exception'`, the parser extracts `exception.type`, `exception.message`, and `exception.stacktrace` from its attributes.

`handleSpan`'s ErrorEvent path reads exception data directly. `span.name` is intentionally absent from the fallback chain — OTel HTTP server instrumentation populates it with the request method (`"GET"`, `"POST"`), which is misleading at the incident surface. `span.status.message` is similarly absent for the same reason. Before the `'unknown error'` floor, the chain reads the failure the span still carries in its attributes even without an `exception` event — the HTTP response context (`"500 on GET /users/:id"`), then a non-HTTP failure: a non-OK gRPC status (`rpc.grpc.status_code` / `rpc.grpc.status_message`, rendered against the canonical gRPC status names) or a transport-level connection error (`error.type`, e.g. `ECONNREFUSED`, named with the peer). The literal `'unknown error'` is the floor for a genuinely opaque failure — no exception, no HTTP context, no gRPC or connection signal — and keeps the schema's required-string contract intact while surfacing the gap:

```
incidentMessage = exception.message
               ?? httpFailureMessage(attrs)       // "500 on GET /users/:id"
               ?? nonHttpFailureMessage(attrs)     // "gRPC UNAVAILABLE", "ECONNREFUSED connecting to pay"
               ?? 'unknown error'
```

The gRPC status-code → name table is a fixed protocol enum (grpc/status.proto), not driver/engine data, so it lives as a constant in `ingest.ts` rather than in `compat.json` — Rule 8 governs engine identification, not a wire enum.

`exception.type` is added to ErrorEvent as an optional field (schema growth via ADR-031). Issue #135.

## HTTP receiver supports JSON and protobuf

The HTTP receiver dispatches on `Content-Type`:

- `application/json` — parsed by Fastify's default JSON parser, fed straight into `parseOtlpRequest`.
- `application/x-protobuf` — buffered as raw bytes, decoded against the bundled `.proto` definitions (ADR-020) via `protobufjs`, reshaped through `reshapeGrpcRequest` (the same path the gRPC receiver uses), then fed into `parseOtlpRequest`. A decode failure returns 400.
- Anything else returns 415.

**Response Content-Type matches the request.** The OTLP spec requires the encoding to be symmetric: a JSON exporter receives a JSON-encoded `ExportTraceServiceResponse`, a protobuf exporter receives a protobuf-encoded one. Mismatched encodings cause client SDKs to log decode errors every batch. Both branches reply with the semantic equivalent of `partialSuccess: {}` (all spans accepted); the protobuf branch encodes `ExportTraceServiceResponse` via the bundled `.proto` (cached after first encode), the JSON branch sends the historical JSON shape with an explicit `Content-Type: application/json` header.

gRPC continues to handle protobuf natively in `otel-grpc.ts`.

## `db.system` is data, not a switch

Engine identification is read from the span attribute as a string and never compared against a hardcoded list. No `if (db.system === 'postgresql')` branches. Engine-specific behavior lives in `compat.json` and is consulted via `compat.ts` per Rule 8 of `docs/contracts.md`.

## Error events

Error-event durability is reconciled with non-blocking ingest in two steps:

1. **Synchronous write at the receiver, before reply.** When the HTTP receiver sees a span with `statusCode === 2` and the daemon wires `onErrorSpanSync`, it builds the `ErrorEvent` and appends it to `errors.ndjson` before sending the 200. On write failure → 500, so the OTel SDK retries. `affectedNode` resolves to `serviceId(span.service)` because graph state isn't yet available at this point.
2. **Asynchronous graph effects via the queue.** `handleSpan` runs from the queue and performs the in-graph error effects (`stitchTrace`, etc.). It does **not** append to `errors.ndjson` again — the receiver-written record is the durable one. `IngestContext.writeErrorEventInline = false` toggles the in-handleSpan write off; the daemon (`watch.ts`) sets this. Ad-hoc CLI/test callers leave it at the default and get a single inline write, so they don't need a receiver to record errors.

Trade-off accepted: `affectedNode` on the durable record is the originating service, not the more precise per-call target the old single-write path could compute. Downstream consumers can join `errors.ndjson` against the live graph at query time when finer attribution matters.

The gRPC receiver still awaits `onSpan` synchronously per request (non-blocking gRPC ingest is out of scope for the v0.2.2 batch), so `watch.ts` wires gRPC with `writeErrorEventInline` left at its default — the inline write covers the durability guarantee on that path.

ErrorEvent shape stays as defined in `@neat.is/types`. The fields added by issue #135 (`exceptionType`, `exceptionStacktrace`) landed via the schema-growth contract.

## What records an incident (amended — refs #481, #614)

An incident records from **any failure span** — a span carrying an ERROR status or an `exception` event — independent of HTTP context, plus a run of failing responses against one peer that accumulates into a signal. The model spans three cases:

1. **Any failure span → one incident.** A span with `status: ERROR` (`statusCode === 2`), an `events[]` entry named `exception`, or `http.response.status_code >= 500` records an incident on its own — the failure signal is what counts, not the presence of HTTP context. A span carrying an ERROR status flows through the §Error-events path above. An `exception` event records an incident even when the span left its status UNSET and carries no HTTP response — the async / queue / background-worker case, a bullmq or Redis-Streams job that throws: `handleSpan` records it, attributed to the span's service and to the handler `file:line` when the span carries `code.filepath`. Its message follows the exception → HTTP context → non-HTTP → `'unknown error'` chain (§Exception data), the same chain every incident write shares. A 5xx records here in `handleSpan` even when its status stays UNSET — OTel HTTP-client semconv leaves a CLIENT span's status UNSET on a 5xx, so a status-only gate is blind to a server-error response; the response-code read closes that. A 5xx that *also* carries ERROR status records once: the response-code path skips `statusCode === 2` so the §Error-events write owns it. The HTTP-status path is a subset of failure-span recording; the exact-`(traceId, spanId)` and one-incident-per-request collapses apply unchanged ([ADR-117](../decisions.md#adr-117--incident-recording-covers-any-failure-span-not-only-http-status-amends-adr-033--adr-113) amends ADR-033 / ADR-113).

2. **A run of 4xx against one peer → one coalesced incident.** A `4xx` `http.response.status_code` on a CLIENT/PRODUCER span feeds a per-`(source, peer)` burst. When `NEAT_INCIDENT_THRESHOLDS.threshold` (default 5) consecutive 4xx land within `NEAT_INCIDENT_THRESHOLDS.windowMs` (default 60s) of each other, one incident records carrying the count (`incidentCount`), the dominant status code (`httpStatusCode`), and the burst's `firstTimestamp` / `lastTimestamp` — span time per §lastObserved-from-span-time, not wall clock. The burst clears on flush; the next run records its own incident. A 4xx more than the window after the previous one starts a fresh burst rather than extending the old one, so a slow trickle of probes never coalesces. Coalescing is what makes 4xx signal: per-span 4xx would let a 404-probing healthcheck drown the history.

3. **An isolated 4xx → no incident.** A lone 4xx is frequently correct application behavior — an auth probe, a conditional fetch, a not-yet-created resource. It records nothing until the burst threshold is crossed.

`NEAT_INCIDENT_THRESHOLDS` is a JSON override (`{ "threshold": <n>, "windowMs": <ms> }`), mirroring `NEAT_STALE_THRESHOLDS`. Either key may be set on its own; the other keeps its default. Both default to the constants near the other ingest tunables in `ingest.ts`.

**One incident per failed request per node (read-time collapse).** A single failed request often produces two error spans in one trace: the span that actually threw (a DB driver, a downstream gRPC call) records its exception, and the HTTP server span that answered 5xx records a *synthesized* HTTP echo of it (`httpFailureMessage`, no exception of its own). Both attribute to the same `(traceId, affectedNode)`, so the request counts twice at the surface. The exact-`(traceId, spanId)` collapse below can't see it — the spanIds differ. `readErrorEvents` runs a second collapse: when a real failure incident shares a `(traceId, affectedNode)` with a synthesized HTTP echo, the echo is dropped so the request counts once. The synthesized echo survives only when it is the sole record for that node in the trace (a clean 5xx with nothing deeper explaining it). This preserves the cross-service split — a caller's failing-response incident (`affectedNode` = the caller) and the callee's exception (`affectedNode` = the callee) land on different nodes, so they stay two separate ledgers as before. The sidecar stays append-only; the collapse is read-time only.

A failing-response incident is attributed to the **source service** — the caller whose outbound calls are failing is the node a debugging session asks about, so `affectedNode` is `serviceId(span.service)` and the peer is carried in the message and the passed-through attributes. This sits alongside the OBSERVED edge's resolved target (frontier or known service); incidents and edges are separate ledgers, and the incident answers "this service's calls to X are failing," not "X failed." `GET /incidents/:nodeId` (which `get_incident_history` wraps) surfaces these on the source service node.

The `ErrorEvent` fields these incidents add (`httpStatusCode`, `incidentCount`, `firstTimestamp`, `lastTimestamp`) are optional schema growth per ADR-031 — the `statusCode === 2` and exception paths keep their shape.

## Unrouted spans (amended v0.4.1 — refs #339)

When a span's `service.name` matches no registered project AND no `default` project is registered, the daemon's routing layer appends a record to `<NEAT_HOME>/errors.ndjson` before dropping the span. The receiver still returns 200 (the OTLP spec is non-negotiable on that), but stderr is no longer the only signal: the operator can read the file to see which service.name strings the OTLP sender is emitting and which never matched.

Record shape:

```json
{ "timestamp": "<iso8601>", "reason": "no-project-match", "service_name": "<string|null>", "traceId": "<string|null>" }
```

A rate-limited stderr warning rides alongside, keyed by `service_name` on the same 60s interval as the broken-project warning so OTel-exporter retries don't flood the console.

## Single-project service-ownership scoping (amended — refs #339)

Single-project mode (ADR-096) binds the bare `/v1/traces` route to the one project the daemon hosts. The OTLP port it binds is shared, though: the OS-default endpoint is `localhost:4318`, so a sibling service belonging to a *different* project that exports with default settings reaches this daemon too. Delivering those spans straight to the slot mints the sibling's `ServiceNode` and incidents into this project's graph — cross-project contamination.

The routing layer scopes delivery to the project's owned services. A span is owned when:

- it carries no `service.name` — an SDK misconfig in this project's own app; `handleSpan` routes it to `service:unidentified` (refs #374), or
- its `service.name` matches the project name the way the multi-project router matches (exact / token-prefix / token-contained, so `brief` owns `brief-api` and `brief-worker`), or
- a `ServiceNode` with that name already lives in the project's graph — statically extracted, or observed-and-adopted on an earlier owned span.

A span owned by none of those is foreign. It quarantines to the unrouted ledger (same record shape and rate-limited warning as above) instead of merging. The trade is deliberate and bounds the blast radius the other direction from §unrouted-spans: a brand-new service of *this* project that NEAT can't read statically and whose name doesn't echo the project name has its first spans quarantined until an extraction round registers it. That gap is small and self-healing; a whole sibling project bleeding into the graph is neither. ADR-096's per-project OTLP-port isolation remains the primary defense — this scoping covers the shared-port fallback. Span-ownership scoping, the incident-message chain (§Exception data), and the one-incident-per-request collapse are formalized in [ADR-113](../decisions.md#adr-113--otlp-ingest-single-project-span-ownership-scoping-richer-incident-messages-one-incident-per-request-amends-adr-033--adr-096).

## Authority

Owned by `ingest.ts` per ADR-030. Receiver shape lives in `otel.ts` / `otel-grpc.ts`; mutation logic lives in `ingest.ts`. No other module mutates the graph through the OTel ingest path. The unrouted-span logging lives in `daemon.ts` because the routing layer owns the "is there a slot to deliver to?" decision.

## Enforcement

`packages/core/test/audits/contracts.test.ts` includes `it.todo` items keyed to issues #131-#135. Each flips to a live assertion as the issue ships:
- non-blocking ingest (timing-based test on the receiver),
- `lastObserved` from span time (replay-a-backdated-span fixture),
- parent-span cache correlation (parent-then-child fixture, child-then-parent fixture),
- auto-creation (span for unseen service produces ServiceNode with `discoveredVia: 'otel'`),
- exception event parsing (span with `events[]` produces ErrorEvent with `exceptionMessage` from the event).

Full rationale and historical context: [ADR-033](../decisions.md#adr-033--otel-ingest-contract).
