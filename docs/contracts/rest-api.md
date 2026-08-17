---
name: rest-api
description: Routes dual-mount at /X and /projects/:project/X per ADR-026. JSON errors. Live graphology only — no graph.json reads at request time. Inbound bodies are Zod-validated. Outbound responses are always JSON objects (never bare arrays) per ADR-061's envelope rule.
governs:
  - "packages/core/src/api.ts"
adr: [ADR-040, ADR-026, ADR-061, ADR-110, ADR-116, ADR-132, ADR-136, ADR-189, ADR-190]
enforcement: [lint, review]
---

# REST API contract

Governs `packages/core/src/api.ts`. Amended 2026-05-11 by ADR-061 (path canonicalization + response envelope rule); paths and shapes in this doc are the canonical source of truth.

## Dual-mount per ADR-026

Every route mounts at both `/X` and `/projects/:project/X`. `registerRoutes(scope, ctx)` is called twice with different scope prefixes. New routes use the helper from day one.

`:project` defaults to `'default'` when missing.

## Response envelope rule (ADR-061)

Every GET response is a JSON object. Never a bare array, never a bare value. The object's top-level keys describe the resource:

- **List endpoints** wrap in plural-noun fields plus a count: `{ count, total, events: [...] }`, `{ violations: [...] }`. `count` is the length of the returned array; `total` is the size of the underlying collection before filtering / limiting.
- **Single-item endpoints** wrap the item in a singular field: `{ node }`, `{ edge }`.
- **Structured-result endpoints** (root cause, blast radius, divergences, diff) return their result type as the top-level object — already objects by virtue of their schema.

Bare arrays from REST endpoints are a contract violation. Why: an object can grow new top-level fields without breaking parsers; a bare array can't.

## Read-side endpoints (canonical paths + shapes)

| Path | Returns | Response shape |
|------|---------|----------------|
| `GET /health` | receiver health + project name | `{ ok, project, uptimeMs }` |
| `GET /graph` | full snapshot (live graphology serialized) | `{ nodes, edges }` |
| `GET /graph/node/:id` | single node by id | `{ node: GraphNode }` |
| `GET /graph/edges/:id` | inbound + outbound edges from a node | `{ inbound: GraphEdge[], outbound: GraphEdge[] }` |
| `GET /graph/dependencies/:nodeId?depth=N` | transitive outbound walk (default 3, max 10) | `TransitiveDependenciesResult` |
| `GET /graph/observed-dependencies/:nodeId` | OBSERVED-only runtime deps, file-grained — for a ServiceNode, the OBSERVED edges of the files it owns too (the call-site processor lands them on files, not the service). Each dependency carries its full per-edge `signal` (`errorCount`, `lastObserved`, `latencyMs`, `anomalous` — the navigation's classification inputs, ADR-190); a node-level **inbound block** `{ inboundVolume, window, inboundLastObserved }` states how hard and how recently production hits *this* node (ADR-190). Names REST parity for the MCP `get_observed_dependencies` tool (ADR-116) | `ObservedDependenciesResult` |
| `GET /graph/blast-radius/:nodeId?depth=N` | BFS inbound — the origin's dependents (default 10, max 20), per [`get-blast-radius.md`](./get-blast-radius.md) / ADR-110 | `BlastRadiusResult` |
| `GET /graph/root-cause/:nodeId` | getRootCause result (navigation: ranked candidates + per-node classification, ADR-189) | `RootCauseResult` |
| `GET /graph/expand/:nodeId?direction=up\|down` | one bidirectional navigation step (ADR-189) — up = callers/dependents, down = callees/dependencies — with per-node classification | `ExpandResult` |
| `GET /graph/relate?a=X&b=Y&maxDepth=N` | pairwise directed link-confirmation (ADR-189): does a path run between a and b, which way, and does it carry the failure | `RelateResult` |
| `GET /graph/diff?against=path` | snapshot diff | `GraphDiffResult` |
| `GET /graph/divergences` | EXTRACTED-vs-OBSERVED divergences (ADR-060) | `DivergenceResult` |
| `GET /graph/ask?q=...` | plain-language door (ADR-196): resolves the question to nodes (token/label + the search embedder, no LLM) and routes it to the existing traversals, answering with one compact, provenance-tagged payload | `AskResult` |
| `GET /search?q=...&limit=N` | semantic search via ADR-025 embedder chain | `{ query, provider, matches: SearchMatch[] }` |
| `GET /incidents?limit=N` | recent ErrorEvents | `{ count, total, events: ErrorEvent[] }` |
| `GET /incidents/:nodeId` | recent ErrorEvents filtered to a node | `{ count, total, events: ErrorEvent[] }` |
| `GET /graph/incident-history/:nodeId` | same handler as `/incidents/:nodeId`, under the graph-query name that mirrors the MCP `get_incident_history` tool (ADR-116) | `{ count, total, events: ErrorEvent[] }` |
| `GET /stale-events?limit=N&edgeType=X` | recent STALE transitions | `{ count, total, events: StaleEvent[] }` |
| `GET /logs?source=X&service=Y&limit=N&since=Z` | recent `LogEntry` records from the bounded per-`(project, source)` store — `source` repeatable, defaults to all (ADR-132) | `{ count, total, logs: LogEntry[] }` |
| `GET /policies` | parsed `policy.json` | `{ version, policies: Policy[] }` |
| `GET /policies/violations?severity=X&policyId=X` | current violations, filterable | `{ violations: PolicyViolation[] }` |
| `GET /policies/applicable?node=X` | soft guardrail (ADR-108): policies that govern a node, matched by direct subject/region. Informs, never blocks | `{ node, applicable: ApplicablePolicy[] }` |
| `GET /connectors` | the project's configured connectors from `~/.neat/connectors.json` (ADR-130), credentials redacted to the env-ref pointer (never resolved), each with its live poll health from the in-process status tracker (ADR-136, `connectors.md` §8) | `ConnectorsStatusResponse` — `{ connectors: ConnectorStatusEntry[] }` |
| `POST /connectors/:id/poll` | run one poll of the named connector on demand and return the outcome (#871, `connectors.md` §8.1); reuses the background loop's `buildRegistration` + `runConnectorPoll` and records the tick in the same status tracker | `{ id, outcome: 'ok', signalsLastPoll, status }`; `404` unknown id, `409` push provider, `400` broken entry, `502 { id, outcome: 'error', error, status }` |
| `GET /instrumentation` | the web ObservedOverlay's honesty probe (#823): fuses `describeProjectInstrumentation` (hook state) with `listUninstrumented` (registry coverage gaps) into the overlay's Mode A / Mode B verdict. Wired and clean → `engaged: true`; a missing hook or a named coverage gap → `engaged: false` plus the one fix command; no scan path or an unreadable `package.json` → `engaged: null` (neutral, never a fabricated cause) | `{ engaged: boolean \| null, diagnosis?: { reason, fixCommand, detail } }` |
| `GET /projects` | the project(s) this daemon serves (single-mount; not dual-mounted). A per-project daemon (ADR-096 §4) returns only its own project; the legacy multi-project daemon returns the machine-wide registry | `Array<RegistryEntry>` *(the one bare-array exception — its consumers (the dashboard's project pin, the CLI's bare-verb resolver) treat it as a list primitive)* |
| `GET /projects/:project` | singular project lookup | `{ project: RegistryEntry }` |
| `GET /api/config` | daemon auth-mode negotiation (ADR-073 §3a); always unauthenticated | `{ publicRead: boolean, authProxy: boolean }` |

The `observed-dependencies` and `incident-history` graph-query routes mirror their MCP tools so REST and MCP expose the same query surface, and `resolveDaemonUrl` reaches any project's daemon rather than only the default port — query-surface parity per [ADR-116](../decisions.md#adr-116--query-surface-parity-observed-dependencies-rest-route-incident-history-rest-route-registry-daemon-resolution-amends-adr-039--adr-040--adr-050).

### The `observed-dependencies` inbound block (ADR-190)

`ObservedDependenciesResult` carries, alongside the per-dependency `signal`, a node-level view of the traffic *into* the node — the "how hard and how recently did production hit this node" story the navigation reads and neat-action's verdict renders:

- `inboundVolume` — aggregate production call volume *into* the node (summed inbound OBSERVED-edge count). Distinct from `inboundObservedCount` (the number of inbound edges) and from any outbound count.
- `window` — labels `inboundVolume` (`"7d"` | `"lifetime"`). The signal is cumulative today, so the honest label is `"lifetime"`; a rolling window ships when the ingest supplies one cheaply. A consumer renders a window only when this field names it — a lifetime count must never be rendered as a 7-day rate.
- `inboundLastObserved` — when production last *called* this node, raw ISO8601. Distinct from a dependency's (outbound) `lastObserved`. Absent when the node has no inbound observation; **never pre-formatted** — the consumer formats "14m ago", the API emits the timestamp.

All recency is emitted raw; no "N× in 7d" / "last seen 14m ago" string is ever built API-side. This pins the neat-action honesty rule ([`action-hosted-seam.md`](./action-hosted-seam.md)): render when present, degrade to counts when absent, never fabricate a window or a timestamp.

## Write-side endpoints

| Path | Effect | Response shape |
|------|--------|----------------|
| `POST /graph/scan` | re-runs static-extraction pass | `{ nodesAdded, edgesAdded, durationMs }` |
| `POST /policies/check` | dry-run policy evaluation; body `{ hypotheticalAction? }` | `{ allowed, violations: PolicyViolation[] }` |
| `POST /snapshot` | merges an incoming snapshot from `neat sync` (ADR-074 §1); body `{ snapshot: SnapshotV3 }` | `{ project, nodesAdded, edgesAdded, nodeCount, edgeCount }` |

## `/extend` endpoints (ADR-081, ADR-086)

Six surgical instrumentation tools. Three read-only, three operative (file-scope-restricted, idempotent, reversible).

| Path | Description | Response shape |
|------|-------------|----------------|
| `GET /extend/list-uninstrumented` | Libraries needing instrumentation beyond the bundle (first-party, third-party, gap) | `{ libraries: LibraryCoverageResult[] }` |
| `GET /extend/lookup?library=X&version=Y` | Registry entry for a specific library | `LibraryCoverageResult` or 404 |
| `GET /extend/describe` | Current OTel hook state: hook files, .env.neat, installed OTel deps | `ProjectInstrumentationState` |
| `POST /extend/apply` | Install instrumentation pkg + splice registration into hook file; body `{ library, instrumentation_package, version, registration_snippet }` | `ExtensionApplyResult` |
| `POST /extend/dry-run` | Preview what apply would do; same body as apply | `ExtensionDiff` |
| `POST /extend/rollback` | Undo last apply for a library; body `{ library }` | `{ undone: boolean, message: string }` |

Dual-mounted at `/extend/...` (default project) and `/projects/:project/extend/...` (named project). File-scope constraint: apply writes only to `instrumentation*.ts`, `otel-init*.ts`, and `package.json`.

The OTLP receiver lives on its own port (`:4318`) — not part of the REST API.

## SSE endpoint

`GET /events` — Server-Sent Events stream per ADR-051 (frontend-facing API contract). Eight-type event taxonomy locked; see [`frontend-api.md`](./frontend-api.md).

## Error responses

JSON shape: `{ error: string, status: number, details?: unknown }`. `400` for bad input / Zod failure, `404` for missing resource, `500` for schema violation. No HTML pages.

## Schema validation

Every `app.post` body parses via Zod schemas from `@neat.is/types`. Failure → 400 with the Zod error in `details`.

Every GET response also parses through its declared schema (per ADR-061's enforcement). Schemas added in this contract:

- `IncidentsResponseSchema`
- `StaleEventsResponseSchema`
- `PoliciesViolationsResponseSchema`
- `GraphNodeResponseSchema`
- `GraphEdgesResponseSchema`
- `HealthResponseSchema`
- `SingleProjectResponseSchema`

Existing typed results (`RootCauseResult`, `BlastRadiusResult`, `TransitiveDependenciesResult`, `DivergenceResult`, `Policy`) already serve as their endpoint's response schemas.

## Live graphology, never `graph.json`

Every read endpoint reads `proj.graph` (live in-memory). Already enforced by Rule 6.

## Path canonicalization (ADR-061 amendment)

Four paths were renamed from drifted backend variants to match the canonical table above:

- `/traverse/root-cause/:nodeId` → `/graph/root-cause/:nodeId`
- `/traverse/blast-radius/:nodeId` → `/graph/blast-radius/:nodeId`
- `/incidents/stale` → `/stale-events`
- `/graph/node/:id/dependencies` → `/graph/dependencies/:nodeId`

No backward-compat aliases. The drifted paths were never on the contract; no non-test consumer called them.

## Authority

Mostly read-only. Two write-side endpoints (`/graph/scan`, `/policies/check`) trigger producers but don't mutate the graph directly.

Full rationale: [ADR-040](../decisions.md#adr-040--rest-api-contract). Amendment rationale: [ADR-061](../decisions.md#adr-061--rest-api-path-canonicalization--response-envelope-rule).
