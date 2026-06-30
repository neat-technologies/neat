---
name: policy-tools
description: Single MCP tool check_policies (covers state-read and dry-run). REST under /policies. MCP resource at neat://policies/violations.
governs:
  - "packages/mcp/src/index.ts"
  - "packages/mcp/src/tools.ts"
  - "packages/mcp/src/resources.ts"
  - "packages/core/src/api.ts"
adr: [ADR-045, ADR-039, ADR-040, ADR-026]
enforcement: [lint, review]
---

# Policy tool surface contract

The fourth of four policy contracts. Sibling contracts: [`policy-schema.md`](./policy-schema.md), [`policy-evaluation.md`](./policy-evaluation.md), [`policy-actions.md`](./policy-actions.md).

## One MCP tool: `check_policies`

```ts
check_policies({
  project?: string,
  scope?: 'all' | 'unresolved' | { policyId: string },
  hypotheticalAction?: { kind: 'promote-frontier' | 'add-edge', ... }
})
```

- **No `hypotheticalAction`** → returns current violations.
- **`hypotheticalAction` provided** → dry-run evaluation, returns violations that would result.

The audit's two-tool split (`evaluate_policy` + `get_policy_violations`) is rejected per CLAUDE.md framing.

## REST endpoints under `/policies`

| Path | Returns |
|------|---------|
| `GET /policies` | parsed `policy.json` |
| `GET /policies/violations` | current violations, `?severity=` and `?policyId=` filterable |
| `POST /policies/check` | dry-run; body `{ hypotheticalAction }` → `{ allowed, violations }` |

The audit's `/policy/violations` (singular) is rejected. `/policies` is the resource root with `/violations` as a sub-resource.

## MCP resource

`neat://policies/violations` — subscribers get `notifications/resources/updated` whenever a new violation appends. Same pattern as `neat://incidents`.

## Three-part response format

`check_policies` returns the format from [mcp-tools.md](./mcp-tools.md). Confidence `1.00` for confirmed violations; lower for hypothetical-action results.

## Project scoping

Routes dual-mount at `/policies` and `/projects/:project/policies` per ADR-026.

Full rationale: [ADR-045](../decisions.md#adr-045--policy-tool-surface-contract).
