---
name: policy-schema
description: policy.json at project root, version 1, discriminated union of six rule types (structural, compatibility, provenance, ownership, blast-radius, field-guard), Zod-validated at load and on file change.
governs:
  - "packages/types/src/policy.ts"
  - "packages/core/src/policy.ts"
  - "packages/core/src/watch.ts"
adr: [ADR-042, ADR-110]
enforcement: [lint, review]
---

# Policy schema contract

The first of four policy contracts. Sibling contracts: [`policy-evaluation.md`](./policy-evaluation.md), [`policy-actions.md`](./policy-actions.md), [`policy-tools.md`](./policy-tools.md).

## File location

`policy.json` at the **project root** — not under `neat-out/`. Version-controlled in the user's repo. Declares the policies the project asserts about its own architecture.

## Top-level shape

```ts
{
  version: 1,
  policies: Policy[]
}
```

`version: z.literal(1)`. Bumping requires an ADR.

## `Policy` shape

```ts
{
  id: string,                  // unique within the file
  name: string,
  description?: string,
  severity: 'info' | 'warning' | 'error' | 'critical',
  onViolation: 'alert' | 'log' | 'block',
  rule: PolicyRule
}
```

`id` uniqueness is checked at load. Duplicates fail loudly.

## Six rule types

Discriminated by `rule.type`:

| Type | Asserts |
|------|---------|
| `structural` | "every ServiceNode must have a CONNECTS_TO edge to a DatabaseNode." |
| `compatibility` | re-runs `compat.ts` against current graph state. Catches OBSERVED-vs-EXTRACTED divergence. |
| `provenance` | "every CALLS edge to `service:payments` must have OBSERVED provenance." |
| `ownership` | "every ServiceNode must declare an `owner` field." |
| `blast-radius` | "no ServiceNode may have more than N transitively-affected dependents." Computed via `getBlastRadius`, which walks inbound to the nodes that break if the subject changes (see [`get-blast-radius.md`](./get-blast-radius.md), [ADR-110](../decisions.md#adr-110--blast-radius-is-the-inbound-dependents-traversal-supersedes-adr-038s-direction)). |
| `field-guard` | "on one node, every member of declared set A must appear in declared set B" ([ADR-169](../decisions.md#adr-169--the-field-guard-policy-a-generic-declared-set-subset-rule-firestorerules-its-first-instance)). Generic and data-configured: `nodeType` (+ optional `nodeKind`), `subjectSet` (the named selector for set A), `guardSet` (the string[] node attribute holding set B). First instance — a Firestore collection: A = client-written columns (`ColumnAttr` whose `sdkWrites` includes `'client'`), B = `guardedFields` folded from `firestore.rules`. A node whose `guardSet` attribute is absent is indeterminate — the check stays silent. |

Each type has its own `PolicyRule<type>` Zod sub-schema. Adding a new type requires an ADR amendment.

## Loading

Loaded at startup; reloaded on file change. The watch loop treats `policy.json` as a phase trigger.

## Validation

`PolicyFileSchema.parse(json)` on load. Failure throws with the Zod error.

Full rationale: [ADR-042](../decisions.md#adr-042--policy-schema-contract).
