---
name: policy-actions
description: Three onViolation actions — log, alert, block. Defaults derive from severity. Block applies to FrontierNode promotion gating and, opt-in, the pre-merge no-regression gate (ADR-277).
governs:
  - "packages/core/src/policy.ts"
  - "packages/core/src/ingest.ts"
  - "packages/mcp/src/resources.ts"
adr: [ADR-044, ADR-093, ADR-094, ADR-277]
enforcement: [lint, review]
---

# Policy onViolation actions contract

The third of four policy contracts. Sibling contracts: [`policy-schema.md`](./policy-schema.md), [`policy-evaluation.md`](./policy-evaluation.md), [`policy-tools.md`](./policy-tools.md).

## Three actions: `log`, `alert`, `block`

No others in MVP.

### `log`

Append to `policy-violations.ndjson`. No surface effect.

### `alert`

`log` + emit MCP `notifications/resources/updated` for `neat://policies/violations`.

### `block`

`log` + `alert` + **prevent** the action that would cause the violation.

**MVP scope: FrontierNode promotion gating only.** A `block`-action policy with a `provenance` or `compatibility` rule can return `{ allowed: false, violations: [...] }` from `canPromoteFrontier(nodeId)`, preventing the rewire.

Other gating points (deploy, codemod, OTel auto-create) need their own ADRs.

## Severity-driven defaults

When `onViolation` is omitted:

| Severity | Default |
|----------|---------|
| `info` | `log` |
| `warning` | `alert` |
| `error` | `alert` |
| `critical` | `block` |

Override per-policy.

## Authority

`packages/core/src/policy.ts`. Calls `appendPolicyViolation` (persist.ts) and `emitMcpNotification`. `block` returns `false` from gating checks; never reverts state.

## `block` widens to the FRONTIER-graduation gate (ADR-093)

The kernel widens `block` from FrontierNode-promotion-only to the **FRONTIER-graduation gate**: a `block`-action policy evaluated against the proposed state `real ∪ delta` ([`policy-evaluation.md`](./policy-evaluation.md) gate path, ADR-094 / ADR-105) **refuses graduation** of a FRONTIER edge — the proposal never lands. Foreign-key-constraint semantics on the proposal channel.

This stays a **prevention primitive, not a revert.** `block` returns `{ allowed: false, violations }` from the graduation gate; it never mutates settled state. Positive OTel evidence cannot override a `block` at graduation; only a human can (ADR-094). The settled flag path is untouched — `block` on a settled fact still only flags, because a fact cannot be un-happened. The MVP FrontierNode-promotion gate above is the first instance; the kernel generalizes it to every proposed FRONTIER edge.

## Block scope tightly bounded

Adding new block points requires an ADR amendment. The FRONTIER-graduation gate (ADR-093) is the sanctioned generalization; other gating points (deploy, codemod, OTel auto-create) still need their own ADRs.

The pre-merge no-regression gate (ADR-277) is the second sanctioned block point: an opt-in, fail-closed gate that refuses a pull request's merge when its blast radius, test suite, divergence delta or security scan does not pass. Like the graduation gate it is a prevention primitive, not a revert, and it gates a pull request in CI or at the host rather than a developer's live edits. It is off unless a repo turns it on, and when on a condition it cannot evaluate counts as not passed.

Full rationale: [ADR-044](../decisions.md#adr-044--policy-onviolation-actions-contract).
