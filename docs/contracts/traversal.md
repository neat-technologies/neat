---
name: traversal
description: traverse.ts is read-only, picks highest-PROV_RANK edge per pair at every hop, excludes FRONTIER entirely, cascades confidence multiplicatively, and validates results against Zod schemas before returning.
governs:
  - "packages/core/src/traverse.ts"
  - "packages/types/src/results.ts"
adr: [ADR-036, ADR-029, ADR-030, ADR-031]
enforcement: [lint, review]
---

# Traversal contract

The shared mechanics under both `getRootCause` and `getBlastRadius`. Sibling contracts: [`get-root-cause.md`](./get-root-cause.md), [`get-blast-radius.md`](./get-blast-radius.md).

## Edge priority — `PROV_RANK` at every hop

When multiple edges connect the same node pair under different provenances (the coexistence case from the [provenance contract](./provenance.md)), traversal picks the highest-priority edge:

```ts
import { PROV_RANK } from '@neat.is/types'

PROV_RANK.OBSERVED   // 3
PROV_RANK.INFERRED   // 2
PROV_RANK.EXTRACTED  // 1
PROV_RANK.STALE      // 0
PROV_RANK.FRONTIER   // 0  (but excluded entirely — see below)
```

`bestEdgeBySource` and `bestEdgeByTarget` apply this rule per neighbour. Selection happens at every step, not just the starting node.

## FRONTIER edges are excluded entirely

FRONTIER means unknown territory. Per Rule 3 of `docs/contracts.md`, traversal must skip these edges, not merely deprioritize them. `bestEdgeBySource` / `bestEdgeByTarget` filter `provenance === FRONTIER` before ranking. If a node's only edges are FRONTIER, traversal halts at that node.

`getRootCause` returns `null` when its only path is via FRONTIER. `getBlastRadius` does not enqueue past a FRONTIER edge; the far-side node simply does not appear in `affectedNodes`.

Issue #136.

## Confidence cascading — multiplicative

Per-edge confidence is `provenance × volume × recency × cleanliness`:

- **provenance ceiling** — OBSERVED 1.0, INFERRED 0.7, EXTRACTED 0.5, STALE 0.3, FRONTIER 0.3.
- **volume** — log-saturating span count: 1 span ≈ 0.55, ~1k spans ≈ 1.0.
- **recency** — 1.0 within an hour, decays toward 0.5 by 24h, 0.3 past.
- **cleanliness** — error rate above ~10% pulls the score down.

Walks of multiple edges multiply per-edge confidences (`confidenceFromMix`). Each hop is independent evidence; uncertainty compounds.

## No mutation

`traverse.ts` is read-only. It calls only `graph.hasNode`, `graph.getNodeAttributes`, `graph.getEdgeAttributes`, `graph.inboundEdges`, `graph.outboundEdges`. It must never call `addNode`, `addEdge*`, `dropNode`, `dropEdge`, `replaceEdgeAttributes`. The mutation-authority scan in `contracts.test.ts` already enforces this per [lifecycle.md](./lifecycle.md).

## Live graph reads

Reads from the live in-memory graphology instance per Rule 6 of `docs/contracts.md`. Never reads `graph.json`.

## Result schema validation

Both `getRootCause` and `getBlastRadius` MUST call `RootCauseResultSchema.parse(...)` / `BlastRadiusResultSchema.parse(...)` before returning. A schema violation throws; the API handler renders a 500. Better than shipping a malformed result.

Issue #139.

## Origin handling

When the origin doesn't exist:

- `getRootCause` returns `null`.
- `getBlastRadius` returns `{ origin, affectedNodes: [], totalAffected: 0 }`.

Neither throws.

## Identity helpers

Any id construction or parsing routes through `@neat.is/types/identity`:

- `parseEdgeId(id)` for walking back from an edge id to its parts.
- `observedEdgeId(...)` / `inferredEdgeId(...)` etc. when synthesizing an id (e.g. checking for an OBSERVED twin during the trace stitcher's [twin-skip rule](./trace-stitcher.md)).

Hand-rolled template literals are a contract violation.

## Enforcement

`packages/core/test/audits/contracts.test.ts` includes:

- Mutation-authority scan covers `traverse.ts` (asserts zero mutating calls outside `ingest.ts` / `extract/*`).
- A live test for FRONTIER exclusion: a graph where the only path between two nodes is via a FRONTIER edge. `getRootCause` returns null; `getBlastRadius` does not include the far-side node. (Issue #136.)
- A live test for schema validation: `RootCauseResult` and `BlastRadiusResult` returned by traversal must `.parse()` cleanly. (Issue #139.)
- Round-trip tests on `confidenceFromMix` to assert multiplicative cascading.

## Rationale

Traversal is read-side. It cannot fix bugs in the producer layers; it can only honestly report what's there. The contract makes that honesty mechanical: priority is locked to `PROV_RANK`, FRONTIER is filtered, confidence cascades according to a documented formula, results validate before they ship.

Full rationale: [ADR-036](../decisions.md#adr-036--traversal-contract).
