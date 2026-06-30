---
name: frontend-api
description: SSE event stream at /events for live graph updates. Locked event taxonomy (8 types). Multi-project switcher endpoint at /projects. WebSocket and per-event filtering deferred to successor ADRs.
governs:
  - "packages/core/src/api.ts"
  - "packages/core/src/streaming.ts"
  - "packages/core/src/events.ts"
  - "packages/core/src/ingest.ts"
  - "packages/core/src/extract/index.ts"
  - "packages/core/src/watch.ts"
  - "packages/core/src/policy.ts"
adr: [ADR-051, ADR-040, ADR-026, ADR-048]
enforcement: [lint, review]
---

# Frontend-facing API contract

The second of two v0.2.8 contracts. Sibling: [`cli-surface.md`](./cli-surface.md).

The existing REST surface (ADR-040) is request-response — fine for initial render, insufficient for live views. Jed's v0.3.0 frontend track needs two things the existing surface doesn't cover: live update streaming, multi-project enumeration. WebSocket-style symmetric subscription is plausibly needed but not surfaced yet.

This contract is **speculative** — it covers the obvious gaps and explicitly defers what isn't surfaced. Sections labeled **(deferred)** wait for v0.3.0 to surface a concrete ask.

## SSE stream at `/events`

Dual-mounted per ADR-026:

```
GET /events                      ← default project
GET /projects/:project/events    ← scoped
```

Content-type `text/event-stream`. Each event line is JSON-encoded, prefixed by `event: <type>` so the EventSource API routes by type:

```
event: node-added
data: {"node":{"id":"service:checkout",...}}

event: edge-added
data: {"edge":{...}}
```

## Event taxonomy (locked)

Eight event types. New types require a successor ADR — same lock discipline as the nine MCP tools.

| Event | Payload | Trigger |
|---|---|---|
| `node-added` | `{ node: GraphNode }` | extract or auto-create in ingest |
| `node-updated` | `{ id: string, changes: Partial<GraphNode> }` | property change in extract / ingest |
| `node-removed` | `{ id: string }` | retire path in extract |
| `edge-added` | `{ edge: GraphEdge }` | any provenance |
| `edge-removed` | `{ id: string }` | retire / promotion rewire |
| `extraction-complete` | `{ project, fileCount, nodesAdded, edgesAdded }` | watch.ts re-extract finishes |
| `policy-violation` | `{ violation: PolicyViolation }` | evaluator emits a new violation |
| `stale-transition` | `{ edgeId, from: 'OBSERVED', to: 'STALE' }` | staleness loop tick |

## Heartbeat

Every 30 seconds: a comment line (`:heartbeat\n\n`) keeps proxies / load balancers from idle-timing out the connection. EventSource clients ignore comments by spec.

## Multi-project switcher

```
GET /projects
```

Returns `Array<{ name, path, status, registeredAt, lastSeenAt?, languages }>` — direct passthrough of `listProjects()` from `registry.ts` (ADR-048). Distinct from the dual-mount routing in ADR-026 (which exposes per-project endpoints); this exposes the registry itself for a project picker UI.

## Backpressure

SSE writes are non-blocking. If a client's socket is slow, events queue up to a per-connection cap (default 1000 messages) before the connection is dropped with `event: error` payload `{ reason: 'backpressure' }`. Independent of OTel span dropping at the ingest layer (ADR-033).

## Error shape unchanged

Same `{ error, status, details? }` envelope from ADR-040. SSE errors land as a final `event: error` payload before the connection closes; non-SSE errors keep the existing JSON-body convention.

## Event emission threading

A single `EventEmitter` singleton in `packages/core/src/events.ts` is the bus. Producers emit:

- `ingest.ts` → `node-added`, `node-updated`, `edge-added`, `edge-removed` (for promotion rewire), `stale-transition`
- `extract/index.ts` → `node-added`, `node-removed`, `edge-added`, `edge-removed`, `extraction-complete`
- `watch.ts` → `extraction-complete`
- `policy.ts` → `policy-violation`

Consumers subscribe inside the SSE handler in `api.ts` / `streaming.ts`. No direct producer-to-handler coupling.

## WebSocket transport (deferred)

Symmetric subscription (client subscribes to specific node ids, sends ping/pong, etc.) waits for a successor ADR. Triggered when v0.3.0 frontend work surfaces a concrete need SSE can't cover. SSE is sufficient for one-way streaming and is the MVP transport.

## Per-event filtering inside SSE (deferred)

The default-project mount streams every event for the default graph; the `/projects/:project/events` mount streams events for that project. Filtering by node id or edge type within a stream is a successor concern.

## Authority

`packages/core/src/api.ts` (extend) for `/projects`. SSE endpoint in `packages/core/src/api.ts` or a new `packages/core/src/streaming.ts` if the surface grows. Event bus in `packages/core/src/events.ts`. Producers in ingest / extract / watch / policy modules emit through the bus.

## Enforcement

`it.todo` for v0.2.8 #24. Regression tests cover: `/events` endpoint with `text/event-stream` content-type, dual-mount per ADR-026, event-type taxonomy locked (eight types), `/projects` endpoint shape, heartbeat interval, backpressure cap.

Full rationale: [ADR-051](../decisions.md#adr-051--frontend-facing-api-contract).
