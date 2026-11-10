# Provenance

NEAT's graph never claims more than it can defend. Every edge — and every result that's built out of edges — carries a `provenance` that says where the information came from. Tools and traversals read it. Confidence cascades from it. Treat this file as the contract between what NEAT knows and how loudly it gets to say so.

## The four states

### EXTRACTED — read from source

Found in code or config. `package.json` declared the dep. `db-config.yaml` named the host. tree-sitter saw the URL literal pointing at another service.

EXTRACTED is the base layer. It is always available — no runtime, no telemetry, no clock — and it goes stale the moment the code changes without a re-scan. Re-running `extractFromDirectory` (or `POST /graph/scan`) is idempotent: same source, same nodes, same edge ids. Don't trust it past your last extraction.

### INFERRED — derived from other edges

Computed, not observed. Today there's exactly one source of INFERRED edges: the trace stitcher. When an upstream span errors (`statusCode === 2`), the stitcher walks the static graph from that service along EXTRACTED edges depth ≤ 2 and writes INFERRED twins of every edge it crosses with `confidence: 0.6`.

Why 0.6? Because we know the system was actively exercising those dependencies during the failing call (the span errored, so traffic was real), but we didn't see the dependency hop directly — we reconstructed it from the static graph. That's worth more than EXTRACTED-only (the code says it's there, nobody confirmed) and less than OBSERVED (we watched it happen).

The stitcher exists for environments with patchy auto-instrumentation. The canonical case is the demo: pg 7.4.0 is too old for `@opentelemetry/instrumentation-pg`, so service-b's `pool.query` calls don't emit a `db.system: postgresql` span. Without INFERRED edges, root-cause traversal would lose the CONNECTS_TO hop and never reach payments-db. The stitcher fills that gap without claiming OBSERVED-grade certainty.

### OBSERVED — seen in production

Live OTel data. A span carried the right semconv attributes (`server.address`, `db.system`, `url.full`), the receiver decoded it, and ingest mapped it to a graph edge with `lastObserved` set to now and `callCount` incremented.

OBSERVED is ground truth at the moment it was recorded. `confidence: 1.0`. If the demo is running and traffic is hitting `localhost:3000/data`, you will see `CALLS:OBSERVED:service:service-a->service:service-b` with a non-zero `callCount` and a `lastObserved` from the last few seconds.

### STALE — was OBSERVED, hasn't been seen recently

OBSERVED edges that haven't been refreshed inside the staleness threshold (24 hours by default; `markStaleEdges` runs on a 60s loop in production). The edge stays in the graph — knowing the relationship existed yesterday is information — but its provenance flips to STALE and confidence drops to 0.3.

STALE is not the same as gone. A service that's been down for an hour has STALE edges; a service that was renamed and never deploys again has STALE edges that may persist forever. Treat STALE as a signal to look, not a verdict.

### A note on FRONTIER

The `Provenance` enum carries a fifth value, `FRONTIER`, for placeholder nodes — "we know this dependency exists because logs name it, but we have no node for the other end." Nothing writes FRONTIER today. It's reserved for the inference layer described in the seed design doc; M5 doesn't ship it.

## Why provenance ranks the way it does

Traversal, in both `getRootCause` and `getBlastRadius`, picks the highest-provenance edge available between any neighbour pair. The order is:

```
OBSERVED  >  INFERRED  >  EXTRACTED  >  STALE  ≥  FRONTIER
```

OBSERVED beats everything because it's the only one anyone watched. INFERRED beats EXTRACTED because the system was demonstrably running when we drew the edge. STALE drops to the floor because "we used to see this" is less useful than "we just looked at the code." FRONTIER is for placeholders that don't have data either way.

## Confidence cascades

`getRootCause` returns a `confidence` between 0 and 1. The rule is:

- **1.0** — every edge in the traversal path was OBSERVED.
- **0.7** — at least one edge was INFERRED. (None had to be EXTRACTED-only.)
- **0.5** — every edge was EXTRACTED-only. The path is plausible from the source code but nobody watched it run.

This is the headline number the consumer reads. A 1.0 root cause is reproducible from real traffic. A 0.5 root cause is a hypothesis derived from `package.json` and YAML.

## How tools surface this

The MCP tools include provenance in their text output. You'll see lines like:

```
Edge provenances: OBSERVED, INFERRED
Confidence: 0.70
```

or, in `get_blast_radius`:

```
  • database:postgresql:payments-db (distance 2, INFERRED)
  • service:service-old (distance 1, STALE — last seen too long ago)
```

Read the provenance the same way you'd read a citation: the more authoritative the source, the more weight you put on the claim.

## Where to look in the code

- Edge ids encode provenance. EXTRACTED: `${type}:${source}->${target}`. OBSERVED: `${type}:OBSERVED:${source}->${target}`. INFERRED: `${type}:INFERRED:${source}->${target}`. The graph is a `MultiDirectedGraph`, so multiple edges between the same pair coexist by design.
- `packages/core/src/ingest.ts` — `handleSpan`, `upsertObservedEdge`, `stitchTrace`, `markStaleEdges`. Everything that turns runtime signal into graph state.
- `packages/core/src/traverse.ts` — `PROV_RANK`, `bestEdgeBySource`, `bestEdgeByTarget`, `confidenceFromMix`. Where provenance ranking is enforced during traversal.
- `packages/types/src/constants.ts` — the `Provenance` enum itself. Adding a sixth state means touching this first.

For the architectural rationale, see `docs/architecture.md` (provenance lifecycle) and `docs/decisions.md` ADR-014 (why INFERRED exists at all).
