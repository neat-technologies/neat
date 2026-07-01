---
name: get-root-cause
description: getRootCause walks incoming edges to depth 5, dispatches by origin node type to a shape-specific compat check, returns a human-readable reason and a derived fix recommendation, validates the result before returning.
governs:
  - "packages/core/src/traverse.ts"
  - "packages/core/src/compat.ts"
  - "packages/types/src/results.ts"
adr: [ADR-037, ADR-114, ADR-014, ADR-029, ADR-031]
enforcement: [lint, review]
---

# `getRootCause` contract

`getRootCause` walks incoming edges from an error-surfacing node looking for an upstream incompatibility that explains the failure. Sibling contracts: [`traversal.md`](./traversal.md) (shared mechanics), [`get-blast-radius.md`](./get-blast-radius.md).

## Origin generality

`getRootCause` accepts any origin node and dispatches by `node.type`:

| Origin type     | Shape                                                              |
|-----------------|--------------------------------------------------------------------|
| DatabaseNode    | driver/engine compat (today's behavior; unchanged)                 |
| ServiceNode     | node-engine + package-conflict shapes from `compat.ts`             |
| InfraNode       | returns null (no matrix shape today)                               |
| ConfigNode      | returns null (no matrix shape today)                               |
| FrontierNode    | returns null (excluded from traversal anyway per ADR-036)          |

The dispatch lives in a `rootCauseShapes` table keyed by `NodeType`. Adding a new shape is one entry, not a code restructure.

Issue #123.

## Walk

`longestIncomingWalk` — DFS backward from origin to depth 5. `ROOT_CAUSE_MAX_DEPTH = 5` is a hardcoded contract value.

The longest path produced becomes the candidate; the first incompatibility found along it is the root cause. If no incompatibility is found, the walk yields no shape match and `getRootCause` moves to the localization steps below.

## Cross-service localization — follow the failing CALLS chain (#589)

An entry service surfaces a failure that actually originates downstream. Nothing calls the entry service, so `longestIncomingWalk` is empty and the incoming shapes find nothing — yet the service's own OBSERVED CALLS edge to the callee carries the failure (`signal.errorCount > 0`). Naive incident matching would self-attribute the caller's CLIENT-side 500 to the entry service and even name a route the entry service never serves.

So for a `ServiceNode` origin, before consulting the incident store against the origin itself, `getRootCause` follows the **outbound** failing CALLS chain to the real culprit:

- A CALLS edge counts as failing when `signal.errorCount > 0`. The chain steps to the callee at the other end of the dominant failing edge (most recorded errors, then highest `PROV_RANK`, then target id — deterministic).
- The caller's CALLS edge may be anchored on a FileNode the service `CONTAINS` (file-awareness §4), not the service node itself; both the service and the files it owns are considered as edge sources.
- The chain walks at most `ROOT_CAUSE_MAX_DEPTH` hops, skipping FrontierNode callees and already-visited services. The deepest still-failing callee — the service whose own downstream calls are clean — is the culprit whose handler actually threw.
- The culprit is then localized through the incident store exactly like the in-process case below (its handler `file:line` / `http.route`), and the failing CALLS edges become the leading hops of `traversalPath` (origin → … → culprit → handler file). Each hop's `provenance` enters `edgeProvenances` in order; the localizing incident hop is `OBSERVED`.
- When the culprit has no recorded incident, the result still names the culprit service (never the caller) with a reason derived from the failing edge that reached it.

Cross-service confidence cascades over the failing CALLS edges and the incident hop, so it sits below an edge-walked compat result. When no outbound call is failing the failure is in-process here and `getRootCause` falls through to the incident store against the origin (#584). Cross-service localization per [ADR-114](../decisions.md#adr-114--root-cause-follows-the-failing-calls-chain-across-services-amends-adr-037).

## Reason

`reason` is human-readable, built from the compat result's `reason` field. Example: `pg 7.4.0 cannot reach PostgreSQL 15 — driver does not support SCRAM-SHA-256 auth`.

When an `errorEvent` is provided, the observed error message is appended in parentheses:

```
${reason} (observed error: ${errorEvent.errorMessage})
```

Never a raw `compat.json` entry; always a sentence.

## Fix recommendation

Derived from the compat result. Today's pattern:

```
Upgrade ${svc.name} ${pair.driver} driver to >= ${result.minDriverVersion}
```

Each compat shape produces its own fix-recommendation string. The shape-specific check is the only place that knows what the fix is; the dispatcher just propagates it. Optional in the result.

## Result shape

```ts
{
  rootCauseNode:    string
  rootCauseReason:  string
  traversalPath:    string[]    // origin → ... → rootCauseNode
  edgeProvenances:  Provenance[]  // length = traversalPath.length - 1
  confidence:       number       // confidenceFromMix(walk.edges)
  fixRecommendation?: string
}
```

`traversalPath[0]` is the origin. The last entry is `rootCauseNode`. `edgeProvenances` is one entry per edge along the path, in order.

## Schema validation

`RootCauseResultSchema.parse(result)` runs before return. Throws on violation; the API handler converts to 500. Issue #139.

## Returns null cleanly

When the origin doesn't exist, when no incompatibility is found, when the origin's node type has no registered shape — `getRootCause` returns `null`. Never throws.

## Compat ownership

`getRootCause` calls into `compat.ts` for the actual incompatibility checks; never duplicates that logic. Compat shape additions land in `compat.json` data, not in `traverse.ts` code.

## Enforcement

`contracts.test.ts` adds:

- A live test that `getRootCause` returns null cleanly when called with an origin whose `node.type` has no registered shape (e.g. ConfigNode).
- A live test that ServiceNode origins produce a result when an upstream service has a node-engine violation (the #123 generalization in action).
- A live test asserting `edgeProvenances.length === traversalPath.length - 1`.
- A live test asserting `RootCauseResultSchema.parse(result)` succeeds for every valid return.
- A live test that `traversalPath[0]` is the origin and the last entry is `rootCauseNode`.

## Rationale

Driver/engine mismatch is the demo's shape but not the only shape. Real codebases have node-version skew, peer-dependency conflicts, deprecated APIs that compile but fail at runtime. Generalizing the dispatcher means `getRootCause` stays useful as the compat matrix grows.

Full rationale: [ADR-037](../decisions.md#adr-037--getrootcause-contract).
