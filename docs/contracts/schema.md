---
name: schema
description: Schema additions in @neat.is/types are growth (commit-and-go). Renames, removals, and type changes are shape changes (require ADR + persist.ts migration).
governs:
  - "packages/types/src/**"
adr: [ADR-031, ADR-019]
enforcement: [lint, review]
---

# Schema growth vs schema shape

`@neat.is/types` schemas have two kinds of changes. The contract treats them very differently because they have very different costs.

## Growth — additive change. Allowed in any commit.

- A new optional field on an existing schema.
- A new enum value (existing switches don't crash on it; they just don't match).
- A new helper export.
- A new exported schema or type.

Code that consumes the previous schema continues to work. Data persisted under the previous schema continues to load. No migration needed.

**Process:**

1. Make the schema change.
2. The schema-snapshot test (`packages/core/test/audits/schema-snapshot.test.ts`) fails on next run.
3. Re-run with `UPDATE_SNAPSHOT=1`:
   ```bash
   UPDATE_SNAPSHOT=1 npm run test --workspace @neat.is/core -- test/audits/schema-snapshot.test.ts
   ```
4. Commit the regenerated `packages/core/test/audits/schemas.snapshot.json` in the **same PR** as the schema change. The diff is the audit trail.

No ADR needed. The snapshot diff itself is the structural record.

## Shape change — breaking. Requires an ADR.

- Renaming a field (`drivers` → `dependencies`).
- Changing a field's type (`string` → `number`, `string` → `enum`).
- Removing a field.
- Removing or renaming an enum value.
- Tightening a refinement so previously-valid data no longer parses.
- Changing the discriminator on a discriminated union.

Code consuming the previous schema breaks. Data persisted under the previous schema fails to load without explicit migration.

**Process:**

1. Open an ADR in the same PR. The ADR records:
   - What changed (field, type, enum value, etc.).
   - Why the breaking change is justified.
   - The migration path in `packages/core/src/persist.ts` (snapshot version bump + migration function).
   - How long the migration is supported.
2. Implement the migration in `persist.ts`. Bump the snapshot version constant. Add a migration function that converts the old shape to the new shape on load.
3. Make the schema change. The snapshot test fails.
4. Re-run with `UPDATE_SNAPSHOT=1`. Commit the regenerated snapshot.
5. The ADR + the snapshot diff + the migration code are the audit trail.

Existing precedent: [ADR-019](../decisions.md#adr-019--remove-pgdriverversion-from-servicenodeschema-snapshot-v1v2-migrates-on-load) (`pgDriverVersion` removal, v1→v2 migration in `persist.ts:13-23`).

## What's snapshotted

The binding schemas in `@neat.is/types`:

- `GraphNodeSchema` (and the five node variants: Service, Database, Config, Infra, Frontier)
- `GraphEdgeSchema`
- `ProvenanceSchema` (Zod enum)
- `EdgeTypeSchema` (Zod enum)
- `ErrorEventSchema`
- `RootCauseResultSchema`
- `BlastRadiusResultSchema`

Identity helpers (`serviceId`, `extractedEdgeId`, etc.) are functions and are governed by ADR-028 / ADR-029 directly, not by the snapshot.

Internal Zod refinements (`.min`, `.max`, `.int`) are recorded when load-bearing for downstream consumers. Cosmetic refinements (`.describe()` strings) are excluded.

## What's *not* snapshotted

- Schemas internal to `@neat.is/core` and `@neat.is/mcp` (those are implementation, not contract).
- Test-only schemas in `packages/*/test/`.
- Frontmatter fields on per-contract markdown files.

## How drift fails

The schema-snapshot test produces a normalized JSON tree of every binding schema and compares to the committed `schemas.snapshot.json`. On any difference:

```
Schema drift detected — the @neat.is/types schemas have changed since the snapshot was taken.

If the change is GROWTH (new optional field, new enum value, additive only):
  Re-run with UPDATE_SNAPSHOT=1 to regenerate, commit the updated snapshot.

If the change is SHAPE (rename, removal, type change):
  Open an ADR documenting why and how persist.ts will migrate old snapshots,
  then regenerate.
```

The diff between current and committed snapshot is printed alongside the failure so the developer can read at a glance whether the change is additive (new field appears, nothing removed) or breaking (field disappears, type changes, enum value missing).

## Why this contract is small

ADR-031 doesn't add helpers or refactor code. It's a meta-contract for how the previous three (identity, provenance, lifecycle) evolve. The snapshot test is the entire enforcement mechanism. No new module, no new abstraction, no migration overhead until a shape change actually lands.

Full rationale and historical context: [ADR-031](../decisions.md#adr-031--schema-growth-versus-schema-shape).
