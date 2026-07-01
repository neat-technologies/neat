---
name: policy-schema
description: policy.json at project root, version 1, discriminated union of five rule types (structural, compatibility, provenance, ownership, blast-radius), Zod-validated at load and on file change.
governs:
  - "packages/types/src/policy.ts"
  - "packages/core/src/policy.ts"
  - "packages/core/src/watch.ts"
adr: [ADR-042]
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

## Five rule types (MVP)

Discriminated by `rule.type`:

| Type | Asserts |
|------|---------|
| `structural` | "every ServiceNode must have a CONNECTS_TO edge to a DatabaseNode." |
| `compatibility` | re-runs `compat.ts` against current graph state. Catches OBSERVED-vs-EXTRACTED divergence. |
| `provenance` | "every CALLS edge to `service:payments` must have OBSERVED provenance." |
| `ownership` | "every ServiceNode must declare an `owner` field." |
| `blast-radius` | "no ServiceNode may have more than N transitively-affected dependents." Computed via `getBlastRadius`, which walks inbound to the nodes that break if the subject changes (see [`get-blast-radius.md`](./get-blast-radius.md)). |

Each type has its own `PolicyRule<type>` Zod sub-schema. Adding a new type requires an ADR amendment.

## Loading

Loaded at startup; reloaded on file change. The watch loop treats `policy.json` as a phase trigger.

## Validation

`PolicyFileSchema.parse(json)` on load. Failure throws with the Zod error.

Full rationale: [ADR-042](../decisions.md#adr-042--policy-schema-contract).
