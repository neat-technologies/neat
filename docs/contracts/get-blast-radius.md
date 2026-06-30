---
name: get-blast-radius
description: getBlastRadius BFS-walks outbound edges to default depth 10, returns affectedNodes with positive distance, edgeProvenance, path, and per-path cascaded confidence. Schema-validated before return.
governs:
  - "packages/core/src/traverse.ts"
  - "packages/types/src/results.ts"
adr: [ADR-038, ADR-029, ADR-031]
enforcement: [lint, review]
---

# `getBlastRadius` contract

`getBlastRadius` BFS-walks outbound edges from an origin and returns every reachable node with the shortest distance, the path, and the cascaded confidence of that path. Sibling contracts: [`traversal.md`](./traversal.md) (shared mechanics), [`get-root-cause.md`](./get-root-cause.md).

## Walk

BFS from origin via `bestEdgeByTarget` per ADR-036. Visits each reachable node once, recording the shortest distance from the origin. FRONTIER edges excluded.

## Depth

`BLAST_RADIUS_DEFAULT_DEPTH = 10` is the default; callers pass `maxDepth` explicitly to override. Practical limit: depth past ~10 produces results dominated by graph branching that aren't useful.

## `affectedNodes` payload

Each entry of `affectedNodes` carries:

```ts
{
  nodeId:          string
  distance:        number          // positive integer (>= 1)
  edgeProvenance:  Provenance      // provenance of the edge that brought traversal to this node
  path:            string[]        // origin → ... → nodeId; length = distance + 1
  confidence:      number          // confidenceFromMix(...edgesAlongPath); in [0, 1]
}
```

Today only the first three fields exist. `path` and `confidence` are schema growth (issue #137); the BFS already tracks parents internally, so surfacing the path is wiring not new computation.

## Distance is positive (issue #138)

`BlastRadiusAffectedNodeSchema.distance` is `z.number().int().positive()` — minimum 1. The origin itself is never in `affectedNodes`. Distance 0 has no meaning.

This is technically a schema **shape** change (previously `nonnegative` allowed 0), but no production data emits `distance: 0` (the BFS at `traverse.ts:266` explicitly skips frame-0). So the migration is no-op. Persist.ts may not need a migration function; the v2→v3 bump shows up in the schema-snapshot diff.

## `totalAffected`

Identity: `result.totalAffected === result.affectedNodes.length`. The origin is never in `affectedNodes`, so `totalAffected` doesn't include the origin.

## Empty origin handling

When the origin doesn't exist or has no outgoing edges:

```ts
{ origin, affectedNodes: [], totalAffected: 0 }
```

Never throws.

## Path ordering

`path[0] === origin` and `path[path.length - 1] === affectedNode.nodeId`. Reverse-path or skip-the-origin variations are contract violations.

## Schema validation

`BlastRadiusResultSchema.parse(result)` before return. Issue #139.

## What's not in scope

- **Inbound expansion.** Blast radius is downstream impact by definition. If you want upstream impact, that's `getRootCause`.
- **Confidence-weighted shortest path.** Shortest by edge count is the v0.2.3 contract. Weighted-shortest is a v1.0 NeatScript concern.
- **Pagination.** Today's MVP graphs are small enough to return the full list. Revisit if real codebase queries return >100 affected nodes.

## Schema-snapshot impact

Adding `path` and `confidence` to `BlastRadiusAffectedNodeSchema` is growth. The schema-snapshot test fails until the developer regenerates with `UPDATE_SNAPSHOT=1` and commits the diff. Tightening `distance` from `nonnegative` to `positive` is technically a shape change but practically a no-op (no real producer emits `distance: 0`). The snapshot diff is the audit trail for both.

## Enforcement

`contracts.test.ts` adds:

- The existing `it.todo` for `BlastRadiusAffectedNode carries path and confidence` (#137) flips to a live assertion.
- The existing `it.todo` for `BlastRadius distance schema rejects 0` (#138) flips to a live assertion.
- The existing `it.todo` for schema validation (#139) flips to a live assertion.
- A new live test asserting `path[0] === origin` and `path[path.length - 1] === affectedNode.nodeId` for every entry.
- A live test that `totalAffected === affectedNodes.length`.
- A live test that the origin itself is not in `affectedNodes`.

## Rationale

Blast radius is the most-asked traversal query at the agent layer — "what breaks if I redeploy / refactor / drop this?" — and the v0.1.x return shape was thin enough that consumers had to infer the path themselves. Surfacing `path` and `confidence` per affected node turns a list-of-nodes into a real explainability surface.

Full rationale: [ADR-038](../decisions.md#adr-038--getblastradius-contract).
