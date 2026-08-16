---
name: traversal
description: traverse.ts is read-only, picks highest-PROV_RANK edge per pair at every hop, excludes FRONTIER entirely, cascades confidence multiplicatively, and validates results against Zod schemas before returning.
governs:
  - "packages/core/src/traverse.ts"
  - "packages/types/src/results.ts"
adr: [ADR-036, ADR-029, ADR-030, ADR-031, ADR-158, ADR-189]
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

## Symbols are first-class path members (ADR-158)

The machinery is generic over node and edge ids, so it walks `SymbolNode`s and the symbol edges (`CALLS`, `INHERITS`, `IMPLEMENTS`) and the observed edges that land on symbols exactly as it walks files — `PROV_RANK` best-edge selection, FrontierNode-skip, the confidence cascade, and schema validation all carry forward unchanged, no branch on grain. A symbol is a member of the path in its own right; it is never rolled up into its owning file's edge (`file-awareness.md §3`, one grain finer). Where a shape needs the file or service that owns a symbol — the compat carrier in `getRootCause`, say — it resolves through the inbound CONTAINS chain (`symbol ◀─CONTAINS─ file ◀─CONTAINS─ service`) and names the carrier while the symbol stays on the traversal path. `getBlastRadius` keeps `CONTAINS` inbound at symbol grain too (`symbol ◀─CONTAINS─ file` puts the owning file in the radius), and `getTransitiveDependencies` walks *through* CONTAINS to reach a symbol's own outbound dependencies without reporting the CONTAINS edge itself. Blast radius and transitive dependencies needed no change to admit symbols; only `getRootCause`'s carrier resolution learned the two-hop chain.

## Foreign-key edges ride the same generic walk (ADR-161)

The same genericity admits data-axis structure with no traversal change. A `REFERENCES` edge (`infra:sql-table:<child> ──▶ infra:sql-table:<parent>`, ADR-161) is one more edge type the walk sees — there is no per-type allowlist, so the moment the extractor mints it, `getBlastRadius` inbound from a parent table enumerates the child tables that FK into it, and `getTransitiveDependencies` outbound from a child reaches its parent. This is the same "a new structural edge is new reach, not new machinery" property that let symbols ride in: FK dependents fall out of the existing inbound BFS exactly as symbol dependents do, provenance-tagged and confidence-cascaded at every hop.

## Navigation moves — Expand, Relate, classification (ADR-189)

`getRootCause`'s agent-driven navigation is new surfaces over these primitives, not a new engine. `Expand(node, up | down)` is one neighbourhood step — `up` over `bestEdgeBySource` (inbound), `down` over `bestEdgeByTarget` (outbound) — so PROV_RANK best-edge selection and FRONTIER exclusion carry forward unchanged. `Relate(a, b)` runs a depth-bounded directed BFS (`findPath`) over those same selectors, capped at `ROOT_CAUSE_MAX_DEPTH`, and returns the finest path the real edges give with per-hop provenance + grain; it never synthesises a finer link than the evidence supports (`file-awareness.md §6`), flagging a `grainGap` instead, and labels a depth-bounded absence "no path within N hops," never "unrelated."

Per-node classification (`primary-failure` / `symptom-only` / `unrelated`) reads only the node's own edge and incident signal — `errorCount`, `latencyMs` (ADR-190), staleness, volume — and so obeys the agnosticity invariant below: it branches on `node.type` / `edge.type` / `provenance` / signal, never on a provider or framework name. The load-origin selection is likewise a topology move (the highest-outbound-volume pure source upstream), chosen by graph shape, not by any node's name. `SATURATION_P95_MS` is a hardcoded absolute threshold, a contract constant like `ROOT_CAUSE_MAX_DEPTH`. All of this stays read-only (below) — the navigation reads the graph, it never mutates it.

## Agnosticity invariant — branch only on node.type / edge.type / provenance (ADR-158 §6)

The reasoning core dispatches only on `node.type`, `edge.type`, and `provenance`. No provider, platform, framework, or language name may be a branch condition anywhere in `traverse.ts` (or any file the root-cause / blast-radius reasoning grows into). To the walk, an OBSERVED edge to a managed Postgres, a self-hosted Mongo, or a payments API is one fact — an observed edge to an external-effect node; the difference between them lives in the adapters (grammars, connectors, framework recognizers, `compat.json`) that normalize into the one universal graph, never in the reasoning. This is what lets a single deterministic trace span a stack of mixed languages, frameworks, platforms, and providers. It is mechanically enforced: `contracts.test.ts` strips comments from the reasoning files and fails on any such name used as a string-literal or compared-identifier branch condition.

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
- The agnosticity scan (ADR-158 §6): reads the reasoning files with comments stripped and asserts no provider / platform / framework / language name gates a branch. Proven to bite by a temporary offending line during development.
- Symbol-grain traversal tests: `getBlastRadius` from a symbol returns symbol dependents across `CALLS` / `INHERITS`, `getRootCause` on a symbol origin resolves to its owning service, and a blast radius from an external node crosses an OBSERVED edge onto the reaching symbol.

## Rationale

Traversal is read-side. It cannot fix bugs in the producer layers; it can only honestly report what's there. The contract makes that honesty mechanical: priority is locked to `PROV_RANK`, FRONTIER is filtered, confidence cascades according to a documented formula, results validate before they ship.

Full rationale: [ADR-036](../decisions.md#adr-036--traversal-contract).
