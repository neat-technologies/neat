---
name: schema
description: Schema additions in @neat.is/types are growth (commit-and-go). Renames, removals, and type changes are shape changes (require ADR + persist.ts migration).
governs:
  - "packages/types/src/**"
adr: [ADR-031, ADR-019, ADR-158, ADR-157]
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

A node-union growth is recorded as a shape event when the ADR chooses to stamp the version, even where the migration is a no-op backfill. [ADR-158](../decisions.md#adr-158) adds `SymbolNode` to `GraphNodeSchema` and steps the snapshot to **v5**: the v5 wire format is a strict superset of v4, so `migrateV4ToV5` is a version-only bump — an older snapshot carries no symbols and re-extraction mints them on the next pass — and the version records the node-union change so a loader knows which node types a snapshot may contain. The `symbolId` helper and its `symbol:<service>:<relPath>#<qualname>` wire format are governed by [identity.md](./identity.md), not the snapshot.

A new edge type is plain growth — a new `EdgeTypeSchema` enum value, no version step. [ADR-161](../decisions.md#adr-161) adds `REFERENCES` (foreign-key `infra:sql-table:<child> ──▶ infra:sql-table:<parent>`) to `EdgeTypeSchema`, exactly as ADR-158 §3 added `INHERITS`/`IMPLEMENTS`: an older snapshot simply carries no FK edges and re-extraction mints them on the next pass, so `SCHEMA_VERSION` is unchanged and only the schema-snapshot (the enum-value diff) records the addition. Adding a new edge type never migrates a snapshot; adding a node union (ADR-158) or a node attribute grain (ADR-157) does.

A new-grain attribute on an existing node is stamped for the same reason. [ADR-157](../decisions.md#adr-157) adds `columns: { name, provenances, confidence }[]` to the `InfraNode` schema — column grain on a table node — and steps the snapshot to **v6**. `provenances` is a deduped set (`Provenance[]`): one column records every side it has been seen with, so a column that is both declared and observed carries `[EXTRACTED, OBSERVED]` rather than one side clobbering the other — the shape that lets column drift (ADR-157 §4) read the declared set and the observed set off a single entry. The field is an optional array (growth on its face), but the ADR stamps the version because the field records a grain the graph can now carry: `migrateV5ToV6` backfills `columns: []` on every table InfraNode (`sql-table` / `supabase-table`) so a loaded snapshot reads present-and-empty rather than absent, the same shape the mint path grows thereafter. The v6 wire format is a strict superset of v5 — an older snapshot's table nodes simply carry no columns, and re-ingestion lands them from the next production `db.statement`. Columns are attributes on the table node, never their own node type, so `GraphNodeSchema`'s variant list is unchanged.

The node-union growth precedent repeats at **v7**. [ADR-168](../decisions.md#adr-168) adds `ServerActionNode` to `GraphNodeSchema` and steps the snapshot to v7, the same shape as the ADR-158 SymbolNode step: the v7 wire format is a strict superset of v6, so `migrateV6ToV7` is a version-only bump — an older snapshot carries no Server Actions and re-extraction mints them on the next pass — and the version records the node-union change so a loader knows which node types a snapshot may contain. The `serverActionId` helper and its `action:<service>:<module>#<exportName>` wire format are governed by [identity.md](./identity.md), not the snapshot. This is the only feature in its batch to stamp the version; the sibling additive features (a new `InfraNode` kind, a new optional attribute, a new policy rule) carry no version step.

[ADR-167](../decisions.md#adr-167) grows `ColumnAttr` by one optional dimension — `sdkWrites: ('client'|'admin')[]`, a deduped set like `provenances`, recording which Firestore SDK wrote each field on a `firestore-collection` node (`client` = firebase/firestore, `admin` = firebase-admin/firestore). This is plain optional growth on top of the v7 wire format, **not** a version step of its own: the field is `.optional()`, appears only on nodes minted after the feature ships, needs no backfill, and rides no `migrateV*`. It is folded by a parallel `foldSdkWrites` helper, leaving `foldColumns` untouched, and is the seam the field-guard policy (ADR-169) joins on. The schema-snapshot records the added enum-typed optional field; `SCHEMA_VERSION` stays at v7.

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
