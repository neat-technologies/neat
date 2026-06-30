---
name: persistence
description: Snapshot at <projectDir>/neat-out/graph.json. SCHEMA_VERSION bumps on shape change only. Forward-only migrations. Append-only ndjson sidecars (errors, stale-events, policy-violations).
governs:
  - "packages/core/src/persist.ts"
adr: [ADR-041, ADR-017, ADR-019, ADR-026, ADR-031, ADR-068, ADR-074]
enforcement: [lint, review]
---

# Persistence contract

Governs `packages/core/src/persist.ts`.

## Snapshot location

Default project: `<scanPath>/neat-out/graph.json` per ADR-017.

Named projects: `~/.neat/projects/<name>/graph.json` per ADR-026.

## Schema versioning

`SCHEMA_VERSION = 4` today. Migration chain:

- **v1 → v2** removed `pgDriverVersion` from ServiceNode (ADR-019); compat traversal reads `dependencies[driver]` instead.
- **v2 → v3** narrowed the provenance enum to four settled values (ADR-068); any edge still carrying the pre-v0.3.5 `FRONTIER` provenance literal is rewritten to OBSERVED on load and re-keyed to the OBSERVED edge-id wire format.
- **v3 → v4** added the ServiceNode env discriminator (ADR-074); the v4 wire format is a superset of v3, so the env-less `service:<name>` form reads as `env='unknown'` and the migration is a version-only bump.

**Schema growth (ADR-031) does not bump the version.** Adding optional fields → snapshot regenerates, version stays. Only **shape changes** bump the version. Each shape change adds a `migrate_vN_to_vN+1` function and bumps the constant.

## Forward-only migrations

Old snapshots load cleanly into the new schema. New snapshots cannot be loaded by old code — intentional.

## Lifecycle

- **Loaded once at startup.** `loadGraphFromDisk` runs in `server.ts` / `watch.ts` boot.
- **Persisted on interval + shutdown.** `startPersistLoop` writes every 60s (configurable) and on `SIGTERM` / `SIGINT`.

Nothing else reads `graph.json` per Rule 6.

## Append-only ndjson sidecars

- `errors.ndjson` — ErrorEvents.
- `stale-events.ndjson` — STALE transitions per ADR-024.
- `policy-violations.ndjson` — policy violations (v0.2.4).

All append-only. No rewrites, no deletions, no rotation. External archival is fine.

## Multi-project isolation

`Map<string, NeatGraph>` keyed by project name. Each project has its own `graph.json` and ndjson sidecars.

Full rationale: [ADR-041](../decisions.md#adr-041--persistence-contract).
