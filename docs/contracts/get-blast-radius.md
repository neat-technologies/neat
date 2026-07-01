---
name: get-blast-radius
description: getBlastRadius BFS-walks inbound edges (the origin's dependents) to default depth 10, returns affectedNodes with positive distance, edgeProvenance, path, and per-path cascaded confidence. Schema-validated before return.
governs:
  - "packages/core/src/traverse.ts"
  - "packages/types/src/results.ts"
adr: [ADR-110, ADR-038, ADR-029, ADR-031]
enforcement: [lint, review]
---

# `getBlastRadius` contract

`getBlastRadius` answers "what breaks if this node changes, fails, or is removed?" That is the set of nodes that **depend on** the origin — its dependents — so the walk follows **inbound** edges. An edge `A ──depends-on──▶ B` means A breaks when B changes; the blast radius of B therefore reaches back along inbound edges to A and everything that transitively depends on A. `getBlastRadius` returns every such dependent with the shortest distance, the path, and the cascaded confidence of that path. Sibling contracts: [`traversal.md`](./traversal.md) (shared mechanics), [`get-root-cause.md`](./get-root-cause.md).

A database, a shared library, or a leaf utility is a pure sink — it has no outbound edges of its own, but plenty of things point at it. Walking inbound is what makes those nodes — exactly the ones you ask "what depends on this?" about — return their real dependents instead of an empty list.

## Direction (ADR-110)

Blast radius is the **inbound-dependents** traversal ([ADR-110](../decisions.md#adr-110--blast-radius-is-the-inbound-dependents-traversal-supersedes-adr-038s-direction)). "What breaks if X changes?" is a question about the nodes that depend on X, so the walk runs inbound — a sink (a database, a shared lib, a config) has dependents pointing at it even when it has no outbound edges of its own, and those are exactly the nodes an agent asks "what depends on this?" about. Outbound-dependency enumeration — "what does X rely on?" — has its own home in `getTransitiveDependencies` / `get_dependencies`; blast radius is its mirror image. ADR-110 sets the direction; ADR-038's depth (10), positive-distance, per-path + cascaded-confidence, and schema validation all carry forward.

## Walk

BFS from origin via `bestEdgeBySource` over each node's **inbound** edges per ADR-036 — for an inbound edge the neighbour is the edge's `source` (the dependent). Visits each reachable dependent once, recording the shortest distance from the origin. FRONTIER edges excluded. This is the same edge-selection and FRONTIER-termination machinery `getRootCause` already walks inbound with; blast radius differs only in that it enumerates every dependent rather than stopping at the first incompatibility.

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

When the origin doesn't exist or has no inbound edges (nothing depends on it):

```ts
{ origin, affectedNodes: [], totalAffected: 0 }
```

Never throws.

## Path ordering

`path[0] === origin` and `path[path.length - 1] === affectedNode.nodeId`. Reverse-path or skip-the-origin variations are contract violations.

## Schema validation

`BlastRadiusResultSchema.parse(result)` before return. Issue #139.

## What's not in scope

- **Outbound (dependency) expansion.** Blast radius is dependent impact by definition. If you want the origin's own dependencies — what it relies on — that's `getTransitiveDependencies` / `get_dependencies`.
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
- A live test that the blast radius of a sink (a database / shared leaf with inbound edges only) returns its dependents, not an empty list.

## Rationale

Blast radius is the most-asked traversal query at the agent layer — "what breaks if I redeploy / refactor / drop this?" That question is about the origin's dependents, so the walk has to run inbound; an outbound walk answers a different question (what the origin depends on) and returns nothing for the sinks agents care about most. Surfacing `path` and `confidence` per affected node turns a list-of-nodes into a real explainability surface.

Full rationale: [ADR-038](../decisions.md#adr-038--getblastradius-contract); the inbound-dependents direction is [ADR-110](../decisions.md#adr-110--blast-radius-is-the-inbound-dependents-traversal-supersedes-adr-038s-direction).
