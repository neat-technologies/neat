---
name: otel-ingest
description: OTel receiver replies before mutation, lastObserved derives from span time, parent-span cache correlates cross-service CALLS, exception data is parsed from span events, unseen services and DBs are auto-created, span-derived edges always carry OBSERVED provenance.
governs:
  - "packages/core/src/ingest.ts"
  - "packages/core/src/otel.ts"
  - "packages/core/src/otel-grpc.ts"
adr: [ADR-033, ADR-113, ADR-029, ADR-030, ADR-068]
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

## What records an incident (amended — refs #481)

An incident records when a span carries an unambiguous failure or when a run of failing responses against one peer accumulates into a signal. The model spans three cases:

1. **Unambiguous failure → one incident.** A span with `status: ERROR` (`statusCode === 2`), an `events[]` entry named `exception`, or `http.response.status_code >= 500` records an incident on its own. ERROR/exception flow through the §Error-events path above; a 5xx records here in `handleSpan` even when its status stays UNSET. OTel HTTP-client semconv leaves a CLIENT span's status UNSET on a 5xx, so a status-only gate is blind to a server-error response — the response-code read closes that. A 5xx that *also* carries ERROR status records once: the response-code path skips `statusCode === 2` so the §Error-events write owns it.

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
