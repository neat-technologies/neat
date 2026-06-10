# NEAT API reference

Reference for consumers building against NEAT's REST + SSE surface. Primary audience: the v0.3.0 frontend track. Secondary audience: any external client wanting to query the live graph.

**Status legend.** Each endpoint is marked:

- ✅ **live** — on `main` today, deployed by `0.2.7` published packages
- 🚧 **planned** — contract locked (ADR-051 / `docs/contracts/frontend-api.md`), implementation in v0.2.8 milestone, shape will not change

Build against shape, not implementation. Planned endpoints have locked contracts — their request/response shapes are stable; they just don't exist on `main` yet.

---

## Base URL + transport

`@neat.is/core` runs an HTTP server. Defaults:

- **Port:** `8080` (override via `PORT`)
- **Host:** `0.0.0.0` (override via `HOST`)
- **Base URL:** `http://localhost:8080`

OTel ingest runs on its own ports (`:4318` HTTP, `:4317` gRPC if `NEAT_OTLP_GRPC=true`) — not part of the consumer-facing API.

## Multi-project routing

Every read endpoint dual-mounts (per ADR-026):

```
GET /<endpoint>                          ← default project
GET /projects/:project/<endpoint>        ← scoped to <project>
```

The default project is named `'default'`. Named projects scope to `~/.neat/projects/<name>/`. Use the `/projects` list endpoint (below) to enumerate registered projects.

## Error envelope

All errors return JSON:

```ts
{
  error: string,        // human-readable message
  status: number,       // HTTP status code (mirrors response status)
  details?: unknown     // optional Zod error details for 400s
}
```

Status codes:
- `400` — bad input (missing arg, malformed body, Zod validation failure)
- `404` — node id / project / resource not found
- `500` — schema violation or internal error

No HTML error pages. JSON-only.

## Type reference

All response types live in `@neat.is/types`. Install with `npm install @neat.is/types` and import:

```ts
import type {
  GraphNode,           // discriminated union: ServiceNode | DatabaseNode | ConfigNode | InfraNode | FrontierNode
  GraphEdge,
  EdgeType,            // const enum: CALLS, CONNECTS_TO, DEPENDS_ON, CONFIGURED_BY, RUNS_ON
  Provenance,          // const enum: OBSERVED, INFERRED, EXTRACTED, STALE, FRONTIER
  RootCauseResult,
  BlastRadiusResult,
  TransitiveDependenciesResult,
  Policy,
  PolicyViolation,
  RegistryEntry,
} from '@neat.is/types'
```

Schemas are exported as Zod objects too (`GraphNodeSchema`, etc.) if you want runtime validation.

---

## Read endpoints

### `GET /health` ✅

Health check + project name.

**Response:**
```ts
{
  ok: boolean,
  project: string,
  uptimeMs: number
}
```

### `GET /graph` ✅

Full snapshot — every node, every edge, with provenance.

**Response:**
```ts
{
  nodes: GraphNode[],
  edges: GraphEdge[]
}
```

**Note:** can be large on real codebases (hundreds of nodes, thousands of edges). For initial render, fine. For incremental updates, subscribe to `/events` (planned) instead of polling.

### `GET /graph/node/:id` ✅

One node by id.

**Path param:** `:id` — node id like `service:checkout` or `database:db.example.com`. Use the helpers from `@neat.is/types/identity` to construct: `serviceId('checkout')`, `databaseId('db.example.com')`, `configId('apps/web/.env')`, `infraId('redis', 'cache.internal')`, `frontierId('payments-api:8080')`.

**Response:**
```ts
{
  node: GraphNode
}
```

`404` if id doesn't exist.

### `GET /graph/edges/:id` ✅

Outbound edges from a node.

**Response:**
```ts
{
  edges: GraphEdge[]
}
```

### `GET /graph/dependencies/:nodeId?depth=N` ✅

Transitive outbound walk via `DEPENDS_ON` and `CONNECTS_TO`. Default depth `3`, max `10`.

**Query:** `depth` (optional, integer 1-10).

**Response:**
```ts
TransitiveDependenciesResult = {
  origin: string,
  dependencies: TransitiveDependency[],
  totalAffected: number
}

TransitiveDependency = {
  nodeId: string,
  distance: number,        // 1 = direct, 2 = one hop further, etc.
  edgeType: EdgeType,
  provenance: ProvenanceValue,
  path: string[]           // origin → ... → nodeId
}
```

### `GET /graph/blast-radius/:nodeId?depth=N` ✅

BFS outbound — every node that would feel a change at the origin. Default depth `10`, max `20`.

**Query:** `depth` (optional, integer 1-20).

**Response:**
```ts
BlastRadiusResult = {
  origin: string,
  affectedNodes: BlastRadiusAffectedNode[],
  totalAffected: number
}

BlastRadiusAffectedNode = {
  nodeId: string,
  distance: number,        // ≥ 1; origin not included
  path: string[],          // origin → ... → nodeId
  confidence: number       // multiplicative cascade across path
}
```

### `GET /graph/root-cause/:nodeId` ✅

Walks incoming edges from a failing node up to depth 5, returns the first divergence — typically a version mismatch or config gap.

**Response:**
```ts
RootCauseResult = {
  origin: string,
  rootCauseNode: string | null,
  reason: string,                          // human-readable
  fixRecommendation: string | null,
  confidence: number,
  edgeProvenances: ProvenanceValue[],      // length = traversalPath.length - 1
  traversalPath: string[]                  // origin → ... → rootCauseNode
}
```

`rootCauseNode: null` means no upstream divergence found — that's a clean answer, not an error.

### `GET /graph/diff?against=<path>` ✅

Snapshot diff between current live graph and a saved snapshot.

**Query:** `against` (required) — path to a graph.json file.

**Response:**
```ts
{
  nodesAdded: GraphNode[],
  nodesRemoved: string[],         // ids
  nodesChanged: { id: string, before: GraphNode, after: GraphNode }[],
  edgesAdded: GraphEdge[],
  edgesRemoved: string[],         // ids
  edgesChanged: GraphEdge[]
}
```

### `GET /search?q=<query>` ✅

Embedding-based semantic search over node names + descriptions. Per ADR-025, uses Ollama → Transformers.js → substring fallback chain.

**Query:** `q` (required, non-empty string).

**Response:**
```ts
{
  query: string,
  results: Array<{
    node: GraphNode,
    score: number             // 0-1, cosine similarity (or substring overlap for fallback)
  }>
}
```

### `GET /incidents` ✅

Most recent error events from OTel exception spans.

**Query:** `limit` (optional, default 50, max 200).

**Response:**
```ts
{
  count: number,
  total: number,
  events: Array<{
    nodeId: string,                // service that errored
    timestamp: string,             // ISO8601
    type: string,                  // exception.type
    message: string,               // exception.message
    stacktrace?: string
  }>
}
```

### `GET /stale-events` ✅

Recent OBSERVED → STALE transitions per ADR-024.

**Query:** `limit` (optional, default 50).

**Response:**
```ts
{
  events: Array<{
    edgeId: string,
    transitionedAt: string,        // ISO8601
    lastObservedAt: string,
    edgeType: EdgeType
  }>
}
```

### `GET /policies` ✅

Parsed `policy.json` for the project.

**Response:**
```ts
{
  version: 1,
  policies: Policy[]              // discriminated union by rule.type
}
```

`404` if no `policy.json` exists for the project.

### `GET /policies/violations` ✅

Active policy violations.

**Query:**
- `severity` (optional) — filter by `info | warning | error | critical`
- `policyId` (optional) — filter by specific policy

**Response:**
```ts
{
  violations: PolicyViolation[]
}

PolicyViolation = {
  id: string,                      // deterministic
  policyId: string,
  severity: PolicySeverity,
  message: string,
  nodeIds: string[],               // affected nodes
  detectedAt: string               // ISO8601
}
```

### `GET /projects` ✅

List of registered projects on this machine. Single-mount, not dual-mounted (it's the switcher itself).

**Response (per ADR-051 #4 — shape locked):**
```ts
Array<{
  name: string,
  path: string,                    // resolved absolute
  status: 'active' | 'paused' | 'broken',
  registeredAt: string,            // ISO8601
  lastSeenAt?: string,             // ISO8601, omitted if never seen
  languages: string[]              // e.g. ['typescript', 'python']
}>
```

Use this to populate a project picker UI.

---

## Write endpoints

### `POST /graph/scan` ✅

Triggers a re-extraction pass against the project's source tree. Returns once extraction completes.

**Body:** none.

**Response:**
```ts
{
  nodesAdded: number,
  edgesAdded: number,
  nodesRemoved: number,
  edgesRemoved: number,
  durationMs: number
}
```

### `POST /policies/check` ✅

Dry-run policy evaluation. Returns what *would* fire if a hypothetical action were taken, without persisting violations.

**Body:**
```ts
{
  hypotheticalAction?: {
    type: 'add-edge' | 'add-node',
    payload: GraphEdge | GraphNode
  }
}
```

**Response:**
```ts
{
  violations: PolicyViolation[]
}
```

---

## Live updates (planned, v0.2.8)

### `GET /events` 🚧

Server-Sent Events stream of live graph mutations. Dual-mounted per ADR-026:

```
GET /events                         ← default project
GET /projects/:project/events       ← scoped
```

**Headers:** standard EventSource.

**Stream format:** one event per SSE message. `event: <type>\ndata: <JSON>\n\n` per the SSE spec.

**Locked event taxonomy (eight types — no quiet additions per ADR-051 #2):**

| Event type | Payload |
|---|---|
| `node-added` | `{ node: GraphNode }` |
| `node-updated` | `{ id: string, changes: Partial<GraphNode> }` |
| `node-removed` | `{ id: string }` |
| `edge-added` | `{ edge: GraphEdge }` |
| `edge-removed` | `{ id: string }` |
| `extraction-complete` | `{ project: string, fileCount: number, nodesAdded: number, edgesAdded: number }` |
| `policy-violation` | `{ violation: PolicyViolation }` |
| `stale-transition` | `{ edgeId: string, from: 'OBSERVED', to: 'STALE' }` |

**Heartbeat:** `:heartbeat\n\n` comment line every 30 seconds. EventSource ignores comments per spec — your client gets nothing visible, but proxies / load balancers don't idle-timeout the connection.

**Backpressure:** if a client's socket falls behind, events queue up to 1000 messages per connection. Past that, the connection drops with a final `event: error\ndata: { reason: 'backpressure' }`.

**Recommended client pattern:**

```ts
const evt = new EventSource('http://localhost:8080/events')

evt.addEventListener('node-added', (e) => {
  const { node } = JSON.parse(e.data)
  graph.addNode(node)
})

evt.addEventListener('edge-added', (e) => {
  const { edge } = JSON.parse(e.data)
  graph.addEdge(edge)
})

evt.addEventListener('error', (e) => {
  // EventSource auto-reconnects on transient errors;
  // backpressure / explicit error events come through here too.
  if (e.data) {
    const { reason } = JSON.parse(e.data)
    if (reason === 'backpressure') /* handle, then re-fetch full graph */
  }
})
```

### Per-event filtering 🚧 (deferred)

Filtering by node id or edge type within a stream is a successor ADR. For MVP, `/events` streams everything for the project; `/projects/:project/events` scopes to that project. If you only care about, say, policy violations, subscribe to all events and filter client-side.

### WebSocket transport 🚧 (deferred)

Symmetric subscription (client subscribes to specific node ids, sends ping/pong) waits for a successor ADR per ADR-051 #6. SSE is sufficient for one-way streaming and is the MVP transport.

---

## Conceptual primer (read once)

NEAT's response shapes carry `provenance` everywhere. Treat each value differently:

| Provenance | Meaning | Trust |
|---|---|---|
| `OBSERVED` | Direct OTel span. Carries `lastObserved` + `callCount`. | Highest — `confidence: 1.0` |
| `INFERRED` | Trace-stitcher output filling gaps in instrumentation. | Medium — `confidence ≤ 0.7`, default 0.6 |
| `EXTRACTED` | Tree-sitter / config parsing. | Lowest — always available, doesn't decay |
| `STALE` | Was OBSERVED, hasn't been seen recently. | Suspicious — `confidence ≤ 0.3` |
| `FRONTIER` | Unresolved span peer (host:port not yet matched). | Skip in traversal — not part of the typed graph yet |

**OBSERVED and EXTRACTED edges coexist** for the same node pair — they live as separate edges with distinct ids. The gap between declared intent (EXTRACTED) and observed reality (OBSERVED) is the load-bearing semantic NEAT exists to surface. Don't merge them in the UI; show both.

**Per-edge confidence** is multiplicative across paths. A blast-radius result with `confidence: 0.42` four hops out means `0.84 × 0.5` (or similar) cascading. Show the number; don't round or hide.

**Edge id wire format:**
- EXTRACTED: `${type}:${source}->${target}` (e.g. `CALLS:service:checkout->service:billing`)
- OBSERVED: `${type}:OBSERVED:${source}->${target}`
- INFERRED: `${type}:INFERRED:${source}->${target}`
- FRONTIER: `${type}:FRONTIER:${source}->${target}`

Use `parseEdgeId` from `@neat.is/types/identity` to deconstruct.

---

## Building locally

```bash
# Install
npm install -g neat.is

# Pick or scaffold a target repo, register it
neat init /path/to/repo --project myrepo

# Start the daemon (blocks foreground; use launchd / systemd / nohup for background)
neatd start

# Confirm
curl http://localhost:8080/health
curl http://localhost:8080/projects
curl http://localhost:8080/projects/myrepo/graph
```

For the planned SSE endpoint, point a browser EventSource at `http://localhost:8080/events` after the v0.2.8 milestone implementation lands (tracking issue #24, contract: `docs/contracts/frontend-api.md`).

---

## When this doc is wrong

- A new endpoint shipped → add it here. Update the status emoji.
- A planned endpoint became live → flip 🚧 to ✅. Remove the "(planned)" qualifier.
- A response shape changed → contract violation. Don't update this doc; fix the regression instead. Shapes are locked once a contract lands.

Sources of truth (in case this doc drifts):
- `packages/core/src/api.ts` — actual route registrations
- `docs/contracts/rest-api.md` — REST contract (ADR-040)
- `docs/contracts/frontend-api.md` — SSE + multi-project contract (ADR-051)
- `packages/types/src/` — every response shape, exported as both TypeScript types and Zod schemas
