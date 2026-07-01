---
name: trace-stitcher
description: stitchTrace fires only on ERROR spans, walks EXTRACTED outbound dependency edges (CALLS / CONNECTS_TO / DEPENDS_ON only) to depth 2, produces INFERRED edges with confidence 0.6, skips hops where an OBSERVED twin already exists, and never touches structural edges (CONTAINS / IMPORTS / CONFIGURED_BY / RUNS_ON).
governs:
  - "packages/core/src/ingest.ts"
adr: [ADR-034, ADR-111, ADR-027, ADR-029, ADR-030]
enforcement: [lint, review]
---

# Trace stitcher contract

The second of three v0.2.2 producer-layer contracts. Governs `stitchTrace` and `upsertInferredEdge` in `ingest.ts`. Sibling contracts: [otel-ingest.md](./otel-ingest.md), [frontier-promotion.md](./frontier-promotion.md).

The trace stitcher is the load-bearing concrete example of NEAT's value (ADR-027). When declared intent and observed reality diverge — a service depending on a driver that can't be auto-instrumented (pg 7.4.0 in the demo, PROVENANCE.md) — the stitcher infers the bridge and labels it as inferred. The user sees what NEAT reasoned about, not just what it observed directly.

## Trigger

`stitchTrace` is called by `handleSpan` only when `span.statusCode === 2`. Non-error spans don't trigger inference: if the call succeeded, the OBSERVED layer captured what it could.

## Depth limit

`STITCH_MAX_DEPTH = 2`, hardcoded. Walking deeper produces speculative edges that are too far from the originating error to claim relevance. The constant is a contract value, not a tunable — changing it requires an ADR amendment.

## Walks EXTRACTED outbound only

The BFS walks `graph.outboundEdges(node)` and considers only edges where `provenance === Provenance.EXTRACTED`:

- OBSERVED edges already carry the relationship — no inference needed.
- INFERRED edges are the stitcher's own output — no recursion.
- FRONTIER edges represent unknown territory and are excluded per Rule 3 of `docs/contracts.md`.
- STALE edges represent decayed observation — not inferable from a fresh error.

## Dependency-edge-type allowlist (binding, ADR-111)

Provenance is not the only gate ([ADR-111](../decisions.md#adr-111--the-trace-stitcher-is-scoped-to-runtime-dependency-edge-types-amends-adr-034)). The stitcher considers an EXTRACTED edge only when its `type` is one of the **runtime dependency** types the ADR-014 case is about:

```ts
CALLS | CONNECTS_TO | DEPENDS_ON
```

These are the edges an error actually propagates along: a service calling a service, a service connecting to a datastore, a declared runtime dependency. An error span means the erroring service was exercising these relationships right now, so inferring an INFERRED bridge for the ones OTel couldn't instrument is honest.

Structural edge types are **never** stitched — not their INFERRED twins, and the BFS does not recurse through them:

- `CONTAINS` — a service owns a file (file-awareness.md §2). Static ownership, not a runtime call. A 500 in one request says nothing new about which files the service contains.
- `IMPORTS` — one file imports another (ADR-092). Compile-time module structure, not traffic.
- `CONFIGURED_BY` — a node's config provenance (ConfigNode existence, ADR-016). Not a dependency the error travels through.
- `RUNS_ON` — deployment placement. Structural, not a runtime call.

The trust signal is the point (PROVENANCE.md): an unrelated request 500-ing must never mint a low-confidence INFERRED twin of a hard EXTRACTED containment or import edge, because a consumer query (`/graph/dependencies`, `/graph/blast-radius`) would then surface the INFERRED twin (conf ~0.6, ranked above EXTRACTED by `PROV_RANK`) in place of the ground-truth structural edge (0.85). Structural facts are learned by static extraction and stay EXTRACTED until static extraction says otherwise; the stitcher does not get a vote on them.

`PUBLISHES_TO` / `CONSUMES_FROM` are not in the allowlist today — the stitcher's demonstrated case (ADR-014, the uninstrumented `pg` driver) is synchronous request-path dependency. Adding a messaging edge type to the allowlist requires an ADR amendment, same as any other contract value here.

## OBSERVED-twin skip rule

When the stitcher considers an EXTRACTED edge `(source, target, type)`, it checks whether an OBSERVED edge for the same triplet already exists:

```ts
if (graph.hasEdge(observedEdgeId(source, target, type))) continue
```

If so, the OBSERVED edge already provides ground-truth coverage for that hop — the stitcher does **not** produce an INFERRED twin. Today the stitcher writes INFERRED edges regardless of OBSERVED twins; the rule closes that gap (verification.md OTel §7).

## Confidence

Default `0.6`, capped at `0.7`. `INFERRED_CONFIDENCE = 0.6` is applied at edge creation. The stitcher does not produce edges with confidence > 0.7 even if a custom override is added later — INFERRED is by definition less trustworthy than OBSERVED, which carries `1.0`. The cap is a contract value.

## Idempotency

When a second error span produces the same stitched edges, `upsertInferredEdge` updates `lastObserved` on the existing edge — it does not create duplicates, does not increment a confidence score, does not add evidence. The edge id (`inferredEdgeId(source, target, type)`) is the deduplication key.

## Origin generality

`stitchTrace(graph, sourceServiceId, ts)` accepts any `service:*` id as the origin. No special-case for the demo (`service:service-b`); no hardcoded driver (`pg`); no hardcoded engine (`postgresql`). The stitcher walks whatever EXTRACTED edges exist outbound from the erroring service.

## No node creation

The stitcher only writes edges. It never creates nodes; it never modifies existing nodes; it doesn't extend across FrontierNode boundaries.

## Authority

`stitchTrace` is owned by `ingest.ts` per ADR-030. Called only from `handleSpan` (error path). No other module triggers stitching.

## Enforcement

`contracts.test.ts` includes:
- A live test asserting `stitchTrace` produces no edges when called with a node that has no outbound EXTRACTED edges.
- A live test asserting `STITCH_MAX_DEPTH` is enforced (depth-3 EXTRACTED chain produces edges only at depth 1 and 2).
- An `it.todo` keyed to the OBSERVED-twin-skip refinement.
- An idempotency test (calling `stitchTrace` twice produces identical edge state).
- A live test asserting an error span from a service with outbound EXTRACTED `CONTAINS` / `IMPORTS` / `CONFIGURED_BY` edges produces no INFERRED twins of those, while a genuine EXTRACTED `CONNECTS_TO` to an uninstrumented backend still gets its INFERRED bridge.

Full rationale and historical context: [ADR-034](../decisions.md#adr-034--trace-stitcher-contract).
