---
name: frontier-promotion
description: FrontierNode promotion fires after every extract pass, alias-matches by name then aliases list, atomically rewires incident edges, preserves edge provenance through the target rewrite. Edge ids during rebuild MUST use canonical helpers.
governs:
  - "packages/core/src/ingest.ts"
  - "packages/core/src/extract/index.ts"
  - "packages/core/src/extract/aliases.ts"
  - "packages/core/src/watch.ts"
  - "packages/core/src/hang-sensor.ts"
adr: [ADR-035, ADR-023, ADR-029, ADR-030, ADR-068, ADR-226]
enforcement: [lint, review]
---

# FrontierNode promotion contract

The third of three v0.2.2 producer-layer contracts. Governs `promoteFrontierNodes`, `rewireFrontierEdges`, and `rebuildEdge` in `ingest.ts`. Sibling contracts: [otel-ingest.md](./otel-ingest.md), [trace-stitcher.md](./trace-stitcher.md).

FrontierNodes (ADR-023) are placeholders for OTel peers that don't match any known service. Promotion replaces a FrontierNode with a real typed node once an alias resolves the host. This contract locks the trigger conditions, alias-match rules, edge-rewrite semantics, and the provenance-preserving target rewrite (ADR-068).

## Trigger

`promoteFrontierNodes(graph)` runs:
- at the end of `extract/index.ts:extractFromDirectory` (every static-extraction pass),
- at the end of every watch-driven phase rerun in `watch.ts`.

**Promotion is batched per pass, not per-edge.** The ingest path itself does not trigger promotion — only the static-extraction lifecycle does, because aliases land during static extraction (compose names, k8s metadata.name, Dockerfile labels via `extract/aliases.ts`).

## Alias matching

The function builds a `Map<string, string>` from every ServiceNode's `attrs.name → id` and `attrs.aliases[i] → id`. Then it walks every FrontierNode and looks up `attrs.host` in the map:

- First match wins.
- If no match, the FrontierNode persists; the next extract pass tries again.
- A FrontierNode whose host happens to equal a service name is promoted on the spot.

Aliases come from `extract/aliases.ts`, which scans docker-compose, k8s manifests, and Dockerfile labels.

## Atomicity

Promotion is atomic per FrontierNode. When a FrontierNode is selected:

1. All incident edges (inbound + outbound) are rewired to the typed-node id via `rewireFrontierEdges`.
2. The FrontierNode is dropped via `graph.dropNode(frontierId)`.

There is no point at which a partial state is visible. ADR-030 §9 atomicity applies.

## Edge rewrite

`rewireFrontierEdges` walks `graph.inboundEdges(frontierId)` and `graph.outboundEdges(frontierId)`. For each, `rebuildEdge`:

1. Drops the old edge.
2. Constructs a new edge id under the typed-node endpoint via the canonical helper.
3. Adds the new edge with the rebuilt attributes — or merges into the existing edge if one is already present at the new id.

This is the only place in the codebase where an edge id changes — not because the edge content changed, but because one of its endpoints did.

## Provenance preserved across promotion (ADR-068)

`rebuildEdge` rewrites only the target ref; the edge's `provenance` value carries forward unchanged. An OBSERVED edge to a FrontierNode promotes to an OBSERVED edge to the matched typed node. An INFERRED edge promotes to an INFERRED edge with the new target. An EXTRACTED edge (rare — FrontierNodes typically carry only OTel-source edges) promotes to an EXTRACTED edge with the new target.

The provenance is locked at edge creation by the producer that emitted it. Spans produce OBSERVED edges with whatever target the OTel attribute resolved to, including FrontierNode targets when the peer is unresolved (per [otel-ingest.md](./otel-ingest.md) and ADR-068). The promotion step is a target-rewrite operation; it doesn't relabel how the edge was learned.

## Edge id construction (binding)

`rebuildEdge` MUST construct the new edge id via the canonical helpers from `@neat.is/types/identity` (ADR-029, ADR-068):

```ts
const newId =
  edge.provenance === Provenance.OBSERVED ? observedEdgeId(newSource, newTarget, edge.type) :
  edge.provenance === Provenance.INFERRED ? inferredEdgeId(newSource, newTarget, edge.type) :
  extractedEdgeId(newSource, newTarget, edge.type)
```

Hand-rolled template literals like `` `${edge.type}:${edge.provenance}:${newSource}->${newTarget}` `` are a contract violation — caught by the variable-interpolation scan in `contracts.test.ts` (provenance contract, ADR-029). The three-arm dispatch is the only allowed shape.

## Edge merge on collision

If the rewritten edge id already exists (because an OBSERVED edge between the typed source and target was previously created independently), the rebuilt edge merges into the existing one:

```ts
{ ...existing,
  callCount: (existing.callCount ?? 0) + (edge.callCount ?? 0),
  lastObserved: pickLater(existing.lastObserved, edge.lastObserved) }
```

No duplicate edge is created.

## No reverse promotion

A typed node never reverts to a FrontierNode. If OTel later observes a peer that matches no known service, a *new* FrontierNode is created at a different host id; the previously-promoted typed node is unaffected.

## Edge promotion — a FRONTIER surface graduates on twin arrival (ADR-226)

Promotion generalizes from node-placeholders to **surface-placeholders**. A FRONTIER edge (ADR-226) is a placeholder for an OBSERVED edge NEAT cannot yet see — a hop it reached toward whose far end hung. `promoteFrontierEdges(graph)` graduates it by the same principle as the node case: when the real twin arrives — an **OBSERVED edge over the same `(source, target, type)`** — the placeholder is **dropped** and the settled OBSERVED edge stands in its place. The twin id is the canonical `observedEdgeId(source, target, type)` (binding, per [Edge id construction](#edge-id-construction-binding) above); the sweep never reconstructs an id by hand.

Node and edge promotion run in **different loops, by design** — each keys on the trigger that can change its state. `promoteFrontierNodes` keys on **extraction** (a new alias resolves a peer), so it runs in the extract sweep. `promoteFrontierEdges` keys on **observed arrival** (an OBSERVED twin lands), so it runs in the periodic post-ingest reconciliation — the staleness loop's `onReconcile` hook (ADR-226), wired in both the daemon and `neat watch`, alongside the hang sensor that stages surfaces (`reconcileFrontierSurfaces` in `hang-sensor.ts`). It is **never gated**: a settled fact is not blockable — the gate (ADR-093) is the *future* face of FRONTIER, not this *present* face. Like node promotion, there is **no reverse promotion**: a graduated OBSERVED edge never reverts to FRONTIER; if the hop later goes quiet it follows the ordinary OBSERVED→STALE path, and a fresh hang stages a new surface.

## Authority

`promoteFrontierNodes` and `promoteFrontierEdges` are owned by `ingest.ts` per ADR-030. Triggered by `extract/index.ts` and `watch.ts`. No other module calls them.

## Enforcement

`contracts.test.ts` includes:
- A live test asserting alias-matched FrontierNode promotion: incident edges rewire to the typed-node target, their `provenance` value is preserved, and the new edge id matches the canonical helper for that provenance (ADR-068).
- A live test scanning for hand-rolled edge id template literals that include a variable-interpolated provenance segment (catches the `${edge.type}:${variable}:...` pattern in `rebuildEdge`).
- A live test asserting `rebuildEdge` routes through `observedEdgeId` / `inferredEdgeId` / `extractedEdgeId` via a three-arm dispatch.

Full rationale and historical context: [ADR-035](../decisions.md#adr-035--frontiernode-promotion-contract).
