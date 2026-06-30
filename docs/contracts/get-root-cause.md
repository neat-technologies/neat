---
name: get-root-cause
description: getRootCause walks incoming edges to depth 5, dispatches by origin node type to a shape-specific compat check, returns a human-readable reason and a derived fix recommendation, validates the result before returning.
governs:
  - "packages/core/src/traverse.ts"
  - "packages/core/src/compat.ts"
  - "packages/types/src/results.ts"
adr: [ADR-037, ADR-014, ADR-029, ADR-031]
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

The longest path produced becomes the candidate; the first incompatibility found along it is the root cause. If no incompatibility is found, `getRootCause` returns null.

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
