---
name: divergence-query
description: The thesis surface. get_divergences as a first-class graph operation across REST, MCP, CLI. Five divergence types, read-only, derived (not persisted). Amends ADR-039 + ADR-050 locked allowlists.
governs:
  - "packages/types/src/divergence.ts"
  - "packages/core/src/divergences.ts"
  - "packages/core/src/api.ts"
  - "packages/core/src/cli.ts"
  - "packages/core/src/cli-client.ts"
  - "packages/mcp/src/index.ts"
adr: [ADR-060, ADR-066, ADR-115, ADR-119, ADR-125, ADR-029, ADR-039, ADR-050, ADR-027, ADR-061, ADR-095]
enforcement: [lint, breaker, review]
---

# Divergence query contract

The synthesis. Every layer in the v0.2.x sequence was building toward this query, and we waited until the end to string it all together. The data layer locked. Static extraction locked. OTel ingest locked. The coexistence rule kept EXTRACTED and OBSERVED legible as separate edges. Traversal walked them. MCP, REST, and CLI surfaces exposed each piece. ADR-027 named the thesis — *"MVP success = closing a real PR on an open-source codebase, where the OBSERVED layer was load-bearing."*

This contract is the one query that says *"here is where what the code claims and what production observes don't match,"* sorted, recommended, ready for the operator to act on.

## Why this is its own contract

`get_divergences` could have been one more tool added to ADR-039's MCP surface and ADR-050's CLI surface as a quiet sub-bullet. It isn't, because:

1. It amends two locked allowlists (ADR-039 nine→ten, ADR-050 nine→ten). The amendments are explicit, not quiet drift.
2. It introduces a new schema (`Divergence`) with five variants — schema growth that warrants its own surface in `@neat.is/types`.
3. The compute logic (`packages/core/src/divergences.ts`) is its own module, with its own rules per divergence type.
4. The thesis-surface framing is itself binding: future contributors should know this query is what NEAT is *for*, not just one read endpoint among many.

## The five divergence types (locked)

Computed against the live graph at request time. No persistence; pure derivation. New types require a successor ADR.

| Type | Detection | Confidence |
|---|---|---|
| `missing-observed` | EXTRACTED edge exists; no OBSERVED edge for the same `(source, target, edgeType)` triple | weighted by the EXTRACTED edge's graded confidence (ADR-066) |
| `missing-extracted` | OBSERVED edge exists; no EXTRACTED edge for the same triple | cascaded from the OBSERVED edge's graded confidence (ADR-066) |
| `version-mismatch` | ServiceNode has declared dependency version; OBSERVED edge to a DatabaseNode (or similar) with incompatible engineVersion per compat.json | `1.0` (compat rule definitive) |
| `host-mismatch` | EXTRACTED CONFIGURED_BY edge points at a config declaring host X; OBSERVED CONNECTS_TO target's host is Y | cascaded from CONNECTS_TO confidence |
| `compat-violation` | Any compat.json rule fires against an OBSERVED edge (broader than version mismatch) | rule-determined |

## Result shape

```ts
DivergenceResult = {
  divergences: Divergence[]      // sorted by confidence desc
  totalAffected: number          // === divergences.length
  computedAt: string             // ISO8601
}

Divergence = (one of five variants, discriminated by `type`)
```

Each `Divergence` carries `source`, `target`, `confidence`, `reason` (human-readable), `recommendation` (human-readable, what to do about it). The type-specific variants carry additional fields (`extracted` edge, `observed` edge, `extractedVersion`, etc.).

## Three surfaces, one query

### REST

```
GET /graph/divergences
GET /projects/:project/graph/divergences
```

Query params: `type=missing-observed,missing-extracted`, `minConfidence=0.6`, `node=service:checkout`.

Returns `DivergenceResult`. JSON error envelope per ADR-040.

### MCP tool

`get_divergences` — **tenth tool**, amends ADR-039's locked allowlist of nine. Tool description (binding documentation per ADR-039):

> *"Returns places where what the code declares (EXTRACTED) doesn't match what production observed (OBSERVED). The single most NEAT-shaped query — the one that justifies the whole graph. Use when the user asks 'is anything weird?' or 'what does production do that the code doesn't?' or 'find me a bug' on an unfamiliar codebase. Returns divergences ranked by confidence × severity. Prefer this over `get_root_cause` when no specific node is failing."*

Three-part response per ADR-039: NL summary + structured `DivergenceResult` + footer (`confidence: <max> · provenance: composite (EXTRACTED + OBSERVED)`).

### CLI verb

`neat divergences` — **tenth verb**, amends ADR-050's locked allowlist of nine. Flags:

- `--type <type[,type]>` — filter by type
- `--min-confidence <float>` — filter by minimum confidence (0.0-1.0)
- `--node <id>` — scope to divergences involving a specific node
- `--json` — machine-readable output per ADR-050 rule 3
- `--project <name>` — project scoping per ADR-026

Default human output: prose summary + plain-text table of divergences sorted by confidence + provenance footer.

## Binding rules

### 1. Read-only

`get_divergences` observes; it does not mutate. No "acknowledge", "dismiss", "snooze" — divergences are derived from the graph; fix the graph (close the EXTRACTED gap, etc.) and they disappear.

### 2. Derived, not persisted

No `divergences.ndjson` sidecar. Each query computes fresh against the live graph. If the user wants history, they diff snapshots (the existing ADR-041 mechanism handles this).

### 3. Schema lives in `@neat.is/types`

`DivergenceSchema` (the discriminated union) and `DivergenceResultSchema` are exported from `@neat.is/types`. Consumers validate query results at the boundary. Schema growth per ADR-031 — `schema-snapshot.test.ts` catches the addition.

### 4. Computation is pure

`packages/core/src/divergences.ts` exports `computeDivergences(graph: NeatGraph, opts?: DivergenceQueryOpts): DivergenceResult`. Pure function: no I/O, no mutation, no async. Operates entirely on the in-memory graph reference.

### 5. Sorted by confidence; OBSERVED-led ties

Default order is `confidence` descending. When confidence ties, `missing-extracted` orders ahead of `missing-observed` so the OBSERVED-led finding leads at the same confidence (ADR-066 §4). Consumer can re-sort.

### 5a. Weighting (ADR-066)

The five divergence types are not symmetric peers. `missing-extracted` is the headline finding type — OBSERVED found an edge that static analysis missed, and that gap is exactly what NEAT's thesis surface exists to surface. `missing-observed` is weighted by the EXTRACTED edge's graded confidence; sub-floor heuristic candidates never enter the graph in the first place (per the static-extraction contract's precision floor), so what surfaces is backed by structural, verified-call-site, or url-literal-service-target evidence — the last being a scheme-qualified URL literal that resolves to a registered service, the declared-HTTP-dependency case (§5 of the static-extraction contract, [ADR-115](../decisions.md#adr-115--url-literal-service-target-grade--infra-connects_to-extraction-amends-adr-066--adr-032)) that lets a declared-but-never-driven upstream surface. `version-mismatch`, `host-mismatch`, and `compat-violation` retain their existing weighting because both sides are specific about a versioned or hostname-identified entity.

### 5b. Envelope (ADR-061)

`/graph/divergences` is a structured-result endpoint per ADR-061 §2 b — it returns the documented `DivergenceResultSchema` shape (`{ divergences, totalAffected, computedAt }`) on snapshot-load, zero-result, and live-state paths at both mount points (default + project-scoped). No `null`, no bare values. The contract scan asserts the shape end-to-end.

### 5c. Route-grained comparison (ADR-119)

Static extraction now reaches route grain: the HTTP client↔route matcher mints a `file ──CALLS──▶ route` EXTRACTED edge whose target is a `RouteNode` at `(method, path-template)` grain (see [`static-extraction.md`](./static-extraction.md), ADR-119). Because that RouteNode is the same node an OBSERVED server-span edge lands on (issue #576), the `missing-observed` / `missing-extracted` pair compares a declared client↔route call against its observed twin at route grain — sharper than the service-grained comparison a host-only edge allows. This is the file-awareness §7 "shared grain" principle applied one level finer: same triple `(source, target, type)`, now with a route as the target. The five divergence types and their weighting (§5a) are unchanged — a route-grained edge is an ordinary EXTRACTED CALLS edge to the query; what changes is how precisely the target names the thing both sides are talking about.

### 5d. OBSERVED-only nodes are excluded from `missing-extracted` (ADR-125)

`missing-extracted` fires when an OBSERVED edge has no EXTRACTED twin on the same `(source, target, type)`. That is the right signal for a CALLS-family edge whose target is a durably-declared artifact — a service, a route, a database — where a static twin *could* exist and its absence is the finding. It is the wrong signal when the **target node is OBSERVED-only by design**: a node that is minted from a span and has no static producer at all can never have an EXTRACTED twin, so flagging its edge as `missing-extracted` reports a gap that no code change could ever close — noise, not signal.

`computeDivergences` therefore suppresses `missing-extracted` when the target is such a node. Two exclusions exist, both keyed on the target so the intent is legible at the point of decision:

- **`CONTAINS` edge type** — structural ownership (service → file / operation / method), never a declared-vs-observed relationship (file-awareness.md §2).
- **`WebSocketChannelNode` target** — a WebSocket channel is minted OBSERVED-only from the HTTP upgrade span (ADR-125, [otel-ingest.md](./otel-ingest.md)); its edge reuses `CONNECTS_TO`, which is in the observable allowlist, so without this exclusion an OBSERVED-only `service ──CONNECTS_TO──▶ ws-channel` would flag a spurious `missing-extracted`.

Both are **signal-preserving, not signal-hiding**: there is no static edge that *should* exist, so suppressing the finding removes a false positive without hiding a real gap. Adding a future OBSERVED-only node type is the moment to consider a matching exclusion — the allowlist stays deliberate.

### 6. Allowlist amendments are explicit

This contract amends ADR-039 (nine→ten MCP tools) and ADR-050 (nine→ten CLI verbs). The amendments are recorded in ADR-060's "Amendments to prior contracts" section. The original ADRs stay frozen; the contract test scans update to include `get_divergences` / `neat divergences` in the allowlist.

### 7. Frontend integration is out of scope here

The frontend surfaces for this query are real and several — `/divergences` page, GraphCanvas annotation, Rail entry, Inspector tab, StatusBar count — but they belong to Jed's v0.3.0 track. Captured separately at `docs/frontend-divergence-suggestions.md` as recommendations, not bindings.

## Divergence is a built-in policy bundle (ADR-095)

Under the governance kernel, the divergence engine is expressed as a **standard, built-in policy bundle** — the five types shipped by default — rather than a separate primitive. `missing-observed` ("an EXTRACTED edge with no OBSERVED twin on the same `(source, target, type)`") is a `provenance` policy; `version-mismatch` / `compat-violation` are `compatibility` policies; structural cases are `structural` policies — all on the policy overlay ([`policy-overlay.md`](./policy-overlay.md), ADR-105). The policy engine is the general form; divergence is a bundle over it.

**The consumer surface is unchanged.** `get_divergences` (REST + MCP + CLI) stays a convenience view over the bundle's violations on *settled* provenance — the flag path — with the same shape, the same five types, the same weighting (§5a). What unifies underneath is the implementation: one evaluator ([`policy-evaluation.md`](./policy-evaluation.md), ADR-043) with a built-in bundle, not two engines. `computeDivergences` (`divergences.ts`) remains the read path and the bundle's view; the unification is that its checks become standard policies evaluated by the same machinery the gate uses.

This is re-expression, not new mechanism: the kernel's flag path (ADR-093) already makes "a settled edge violating a policy" the divergence output, so divergence-as-bundle is the same checks spoken in the policy vocabulary. New divergence types still require a successor ADR; they now arrive as bundle policies.

## Authority

- **Schema:** `packages/types/src/divergence.ts` — new file
- **Computation:** `packages/core/src/divergences.ts` — new file, pure
- **REST surface:** `packages/core/src/api.ts` — add `GET /graph/divergences`, dual-mounted per ADR-026
- **MCP surface:** `packages/mcp/src/index.ts` — register tenth tool, route via REST client
- **CLI surface:** `packages/core/src/cli.ts` + `packages/core/src/cli-client.ts` — register tenth verb, plumb through

## Enforcement (ADR-066 additions)

New live assertions in the `Divergence query (ADR-060)` describe block of `contracts.test.ts`:

- `missing-extracted` orders ahead of `missing-observed` at the same confidence grade.
- `missing-observed` rows whose EXTRACTED edge graded below the precision floor never enter the graph, and therefore never appear in `computeDivergences` output.
- `/graph/divergences` returns `DivergenceResultSchema` on snapshot-load (graph reconstructed from `graph.json`), zero-result (no divergences detected), and live-state paths — at both mount points.

Initial entries are `it.todo` in the contract PR; they flip live in the v0.3.4 implementation PRs.

## Enforcement (ADR-060 baseline)

`it.todo` block in `contracts.test.ts` for ADR-060:

- `DivergenceSchema` exists in `@neat.is/types` with the five-variant discriminated union; each variant parses cleanly with valid fixture data.
- `DivergenceResultSchema` exists and validates the wrapped result shape.
- `GET /graph/divergences` is registered and dual-mounted per ADR-026 (both `/graph/divergences` and `/projects/:project/graph/divergences`).
- `get_divergences` is registered as the tenth MCP tool — amends the ADR-039 allowlist scan.
- `neat divergences` is registered as the tenth CLI verb — amends the ADR-050 allowlist scan.
- For each of the five divergence types: a fixture graph triggers the type; the query returns the expected divergence with correct discriminator + schema fields.
- Read-only: `divergences.ts` contains no graph mutation calls (mutation-authority scan extended to cover this file).
- Filtering: `?type=`, `?minConfidence=`, `?node=` each narrow the result correctly.
- Default sort: results returned in `confidence` descending.

Full rationale: [ADR-060](../decisions.md#adr-060--get_divergences---the-thesis-surface).
