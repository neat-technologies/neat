---
name: lifecycle
description: When nodes and edges are created, transition, get rewritten, or retire. Authority over each transition is locked to one module.
governs:
  - "packages/core/src/ingest.ts"
  - "packages/core/src/extract/index.ts"
  - "packages/core/src/watch.ts"
  - "packages/core/src/persist.ts"
  - "packages/core/src/traverse.ts"
  - "packages/core/src/api.ts"
  - "packages/mcp/src/**"
adr: [ADR-030, ADR-024, ADR-023, ADR-093, ADR-094]
enforcement: [lint, review]
---

# Lifecycle contract

When does a node enter the graph. When does it transition. When does it leave. Same for edges. The graph is mutated by exactly two modules — every other module is read-only.

## Mutation authority

```
ingest.ts          — OBSERVED, INFERRED, FRONTIER edges; FRONTIER nodes;
                     OBSERVED ↔ STALE transitions; FrontierNode promotion;
                     edge rewrite during promotion.
extract/*          — Static (EXTRACTED) nodes and edges only.
extract/index.ts   — triggers promoteFrontierNodes after extract pass.
watch.ts           — triggers promoteFrontierNodes + staleness loop on tick.
```

**Every other module is read-only.** `traverse.ts`, `compat.ts`, `persist.ts` (except snapshot load/save), `api.ts`, and all of `packages/mcp/` must not call `addNode`, `addEdge*`, `dropNode`, `dropEdge`, `replaceEdgeAttributes`, or `replaceNodeAttributes`.

## Node lifecycle

| Stage | Owner | Trigger |
|-------|-------|---------|
| **Created (typed)** | `extract/{services,databases,configs,infra}` | static analysis on `init` or on a `watch` re-extract pass |
| **Created (auto)** | `ingest.ts` `handleSpan` | OTel span for unseen `service.name` (queued under #134) |
| **Created (frontier)** | `ingest.ts` `handleSpan` | OTel resolves a peer host that doesn't match any known service or database |
| **Promoted** | `ingest.ts` `promoteFrontierNodes` | a FrontierNode's `host` matches a known service alias |
| **Retired (frontier-on-promote)** | `ingest.ts` `promoteFrontierNodes` | atomic with promotion |
| **Retired (ghost cleanup)** | `watch.ts` (queued under #140) | source file disappears between extract passes |

Auto-created and static-extracted nodes **merge by id**. Static fields (language, version, dependencies) override auto-created fields. OTel-derived fields (lastObserved on associated edges) survive untouched.

FrontierNode promotion is **atomic per node**: a FrontierNode never persists in a partial state. Its incident edges are rewritten and the node itself is dropped in one synchronous pass.

## Edge lifecycle

| Stage | Owner | Trigger |
|-------|-------|---------|
| **Created (EXTRACTED)** | `extract/*` | static analysis |
| **Created (OBSERVED)** | `ingest.ts` `upsertObservedEdge` | OTel cross-service span; both endpoints must exist (returns null otherwise — see #134) |
| **Created (INFERRED)** | `ingest.ts` `upsertInferredEdge` | trace stitcher, depth ≤ 2 from an error span |
| **Created (FRONTIER)** | `ingest.ts` `upsertFrontierEdge` | OTel peer host doesn't match any known node |
| **Updated (OBSERVED)** | `ingest.ts` `upsertObservedEdge` | repeat span on existing edge id; refreshes `lastObserved`, increments `callCount` |
| **OBSERVED → STALE** | `ingest.ts` `markStaleEdges` | background `setInterval` (default 60s); per-edge-type thresholds (ADR-024); transition is in place — id stays the same |
| **STALE → OBSERVED (resurrection)** | `ingest.ts` `upsertObservedEdge` | implicit on next span arrival; same edge id, attributes overwritten |
| **FRONTIER → OBSERVED** | `ingest.ts` `rebuildEdge` (during promotion) | only via FrontierNode promotion; never standalone |
| **Retired (rewrite-on-promote)** | `ingest.ts` `rewireFrontierEdges` | edges incident to a promoted FrontierNode are dropped and rebuilt under the typed-node id |
| **Retired (ghost cleanup)** | `watch.ts` (queued under #140) | source file edited or removed; EXTRACTED edges keyed to the file are dropped |

## Transition rules (binding)

- **STALE → OBSERVED is implicit.** No explicit "resurrect" function exists. A new span hitting a STALE edge re-runs `upsertObservedEdge`, which overwrites `provenance` to `OBSERVED` and `confidence` to `1.0` because the OBSERVED id and the post-STALE id are the same string.

- **FRONTIER → OBSERVED only via promotion.** A FRONTIER edge cannot become OBSERVED in isolation. It transitions only when its FrontierNode endpoint resolves to a typed node and the edge is rebuilt under the typed-node id. The provenance is upgraded during the rebuild because the call certainty was always there — only the target identity was unknown.

- **EXTRACTED never decays.** EXTRACTED edges either exist (the static analyzer found them) or they don't. They have no `lastObserved` and don't participate in the staleness loop.

- **INFERRED never transitions.** INFERRED edges live until either (a) ghost cleanup retires them when their underlying static evidence is gone, or (b) an OBSERVED edge for the same node pair lands and traversal preference makes them invisible. They don't decay on a clock.

- **No backward transitions for FrontierNode.** A typed node never reverts to FrontierNode. If OTel later observes a peer that matches no known node, a *new* FrontierNode is created — the old typed node is unaffected.

## The mutation path branches on provenance — the kernel gate (ADR-093 / ADR-094)

On top of the authority table above, the kernel routes a mutation by its incoming provenance:

- **Settled provenance (OBSERVED / EXTRACTED / INFERRED / STALE) → record-and-flag.** The write lands unconditionally through its owner (`ingest.ts` / `extract/*`); policies evaluate *after* (the flag path). No blocking check enters the high-volume ingest path — a settled fact is real on arrival (ADR-093).
- **FRONTIER provenance → gate.** A FRONTIER edge (ADR-094, written only by the kernel's proposal path) does **not** graduate until the policy gate evaluates the proposed state `real ∪ delta` and passes ([`policy-evaluation.md`](./policy-evaluation.md) gate path, ADR-105). On pass, the existing **FRONTIER → OBSERVED** promotion path graduates it; on a `block` it is **refused** (never lands); on an expired observation window it is **culled** (retired). Graduation, refusal, and culling are the three FRONTIER exits.

This adds a gate *before* the `FRONTIER → OBSERVED` transition already in the edge table; it does not change any settled transition. Mutation authority stays locked to `ingest.ts` and `extract/*` — the proposal channel writes FRONTIER through `ingest.ts` (`upsertFrontierEdge`), and the gate is a read-only evaluation over the proposed graph before promotion.

## Idempotency

Every creation path is idempotent. Re-running the same producer with the same input produces the same graph state. `graph.hasNode(id)` and `graph.hasEdge(id)` guards make this hold under watch-driven re-extraction.

## Atomicity

Each lifecycle operation is synchronous within a single call to its owner function. Node's single-threaded event loop guarantees no partial transition is observable to a concurrent reader. Multi-process ingest is not a concern at MVP scale; if it becomes one (post-v1.0 / post-eBPF), atomicity gets its own ADR.

## Enforcement

`packages/core/test/audits/contracts.test.ts` includes:

- A scan asserting no graph-mutation method (`addNode`, `addEdge*`, `dropNode`, `dropEdge`, `replaceEdgeAttributes`, `replaceNodeAttributes`) is called from outside `packages/core/src/ingest.ts` and `packages/core/src/extract/`.
- A round-trip test for STALE → OBSERVED resurrection on a single edge id.
- A round-trip test for FRONTIER → OBSERVED on FrontierNode promotion.

## Rationale

Lifecycle was correct but invisible: each transition lived inside `ingest.ts` or `extract/` with no document specifying who owned what. Contract #4 (schema growth vs shape) and every producer / consumer rebuild from v0.2.1 onward depends on the lifecycle being explicit. Without it, v0.2.2's OTel rebuild can't define what "auto-create" means without re-litigating the merge rule.

Full rationale and historical context: [ADR-030](../decisions.md#adr-030--node-and-edge-lifecycle).
