---
name: persistence
description: Snapshot at <projectDir>/neat-out/graph.json. SCHEMA_VERSION bumps on shape change only. Forward-only migrations. Append-only ndjson sidecars (errors, stale-events, policy-violations, baselines). Healthy baselines keyed on the healthy event, content-addressed object specs.
governs:
  - "packages/core/src/persist.ts"
  - "packages/core/src/healthy-baseline.ts"
adr: [ADR-041, ADR-017, ADR-019, ADR-026, ADR-031, ADR-068, ADR-074, ADR-270, ADR-280]
enforcement: [lint, review]
---

# Persistence contract

Governs `packages/core/src/persist.ts`.

## Snapshot location

Default project: `<scanPath>/neat-out/graph.json` per ADR-017.

Named projects: `~/.neat/projects/<name>/graph.json` per ADR-026.

## Schema versioning

`SCHEMA_VERSION = 11` today. Migration chain:

- **v1 → v2** removed `pgDriverVersion` from ServiceNode (ADR-019); compat traversal reads `dependencies[driver]` instead.
- **v2 → v3** narrowed the provenance enum to four settled values (ADR-068); any edge still carrying the pre-v0.3.5 `FRONTIER` provenance literal is rewritten to OBSERVED on load and re-keyed to the OBSERVED edge-id wire format.
- **v3 → v4** added the ServiceNode env discriminator (ADR-074); the v4 wire format is a superset of v3, so the env-less `service:<name>` form reads as `env='unknown'` and the migration is a version-only bump.
- **v4 → v5** added `SymbolNode` to the node union (ADR-158); the v5 wire format is a superset of v4, so `migrateV4ToV5` is a version-only bump — an older snapshot carries no symbols and re-extraction mints them on the next pass.
- **v5 → v6** added column grain to a table InfraNode (ADR-157); `migrateV5ToV6` backfills `columns: []` on every table node so a loaded snapshot reads present-and-empty rather than absent.
- **v6 → v7** added `ServerActionNode` to the node union (ADR-168); the v7 wire format is a superset of v6, so `migrateV6ToV7` is a version-only bump — an older snapshot carries no Server Actions and re-extraction mints them on the next pass.
- **v7 → v8** added `DependencyNode` to the node union and the optional `dependency` facts on an edge (ADR-274); the v8 wire format is a superset of v7, so `migrateV7ToV8` is a version-only bump. An older snapshot carries no dependencies, and the next extract pass mints them from the lockfile.
- **v8 → v9** keyed a networked DatabaseNode on engine and host (ADR-276). `migrateV8ToV9` re-keys every `database:<host>` node to `database:<engine>:<host>` and re-points its edges.
- **v9 → v10** added `declaredBy` to every static node and EXTRACTED edge (#1729, #1698 slice zero). `migrateV9ToV10` seeds each FileNode's `declaredBy` from its ADR-233 `source`, the one owner a v9 snapshot records. Every other element's declarers stay absent, which reads as unknown, until the next pass that names a source stamps them.
- **v10 → v11** put the environment on runtime evidence instead of on a service's identity (ADR-280). `migrateV10ToV11` folds each env-tagged OTel ServiceNode twin into the extracted ServiceNode of the same name (case-insensitive), re-pointing its OBSERVED, INFERRED and STALE edges and re-keying them with the twin's normalised environment (`OBSERVED@<env>`), merging into an edge already at that id (counters add, the later `lastObserved` wins). An OTel-only ServiceNode whose `env` is not normalised moves to its normalised id. Every other edge keeps its id: an OBSERVED edge with no environment is already the `unknown` edge. Idempotent. Incidents are not rewritten; one with no `env` reads as `unknown` ([env-dimension.md](./env-dimension.md) §5).

**Schema growth (ADR-031) does not bump the version.** Adding optional fields → snapshot regenerates, version stays. Only **shape changes** bump the version. Each shape change adds a `migrate_vN_to_vN+1` function and bumps the constant.

## Forward-only migrations

Old snapshots load cleanly into the new schema. New snapshots cannot be loaded by old code — intentional.

That holds at both entry points, through one function: `migrateSnapshot` runs the chain for a snapshot read off disk (`loadGraphFromDisk`) and for one pushed over `POST /snapshot` by `neat sync --to`. A push from an older CLI is brought forward and merged; a push newer than the daemon is refused with its version named, since there is nothing to migrate down to. The push route used to compare versions for exact equality, so every bump made every already-published CLI's `sync --to` answer 400 until the user upgraded (#1307).

## Lifecycle

- **Loaded once at startup.** `loadGraphFromDisk` runs in `server.ts` / `watch.ts` boot.
- **Persisted on interval + shutdown.** `startPersistLoop` writes every 60s (configurable) and on `SIGTERM` / `SIGINT`.

Nothing else reads `graph.json` per Rule 6.

## Append-only ndjson sidecars

- `errors.ndjson` — ErrorEvents.
- `stale-events.ndjson` — STALE transitions per ADR-024.
- `policy-violations.ndjson` — policy violations (v0.2.4).
- `findings.ndjson`: the first time a qualifying finding is present at a commit, and when it clears (ADR-279, [`finding-triggers.md`](./finding-triggers.md)). Bounded: at 16 MiB or 10,000 rows the rows of the oldest commits are dropped.

All append-only. No rewrites, no deletions, no rotation. External archival is fine.

## Healthy baselines (ADR-270)

What the system's declared objects looked like the last time it was healthy, so a card can say what changed since. Written by `healthy-baseline.ts` after each Kubernetes poll, beside the incident ledger:

- `baselines.ndjson`: one manifest per baseline, append-only like the other sidecars, `{ takenAt, objects: { <id>: { node, hash } }, flags: { <id>: hash }, erroringEdges: [edgeId] }`. Object ids are `k8s:<kind>/<namespace>/<name>`, the identity a fingerprinting watch keys on too. A few KB each.
- `baselines/objects/<hash>.json`: one file per distinct object spec or flag state, content-addressed by its `specHash`, written once. An unchanged object costs nothing on the next baseline.

- `env-hash.key`: the project's env-hash salt (ADR-266 amendment), 32 random bytes as hex, mode 0600. It keys the `valueHash` on literal env entries, so the snapshot and the baselines carry hashes that only tell same from different. It also keys ConfigMap data hashes (`hmac:<16 hex>` per key, ADR-270 amendment). It is not a sidecar: nothing reads it but the k8s leg and the baseline reader, it is never in `graph.json` or a baseline, and nothing syncs it. A baseline written before the file is never a base for `/graph/changes`, since it hashed values another way; deleting the file therefore drops every earlier baseline as a base.

**When one is written.** The system is healthy when every workload the poll read is Ready (the poll carries no deploy-fault incident) and no node has begun failing since the last baseline and is still failing (its latest incident within five minutes). Healthy must hold over at least two consecutive polls of the same state and `NEAT_BASELINE_HOLD_MS` (default 30 s); a poll whose objects differ from the last starts the hold again, so a changed spec becomes the baseline only after it has itself been healthy that long. A new manifest is appended only when its objects, flags or erroring edges differ from the last. The baseline rolls: a legitimate deploy becomes the new healthy state. Production can raise the hold to minutes to ride out a slow rollout; the default is short because a SREGym attempt goes from Ready to an injected fault in about a minute.

**The invariant.** A reader picks the latest baseline written before the failure's onset (`GET /graph/changes?at=`). A baseline written after the onset is never the base, whatever was healthy by Kubernetes then.

**What is kept.** Each object's `observedSpec` exactly as the connector stamps it, so the baseline never holds anything the node may not (no env values, #1503; redaction per ADR-237); ConfigMap data as key → hash, never a value; Secrets not at all; flag definitions as the store serves them. No ledger of every poll and no rotation: the manifest only grows when the healthy state changes. This is the first step of time as an axis (#1475): snapshots keyed on the healthy event.

Graph snapshots and baselines are separate. `graph.json` is still read only by the persist path (Rule 6); a baseline is read only by `healthy-baseline.ts`.

## Multi-project isolation

`Map<string, NeatGraph>` keyed by project name. Each project has its own `graph.json` and ndjson sidecars.

Full rationale: [ADR-041](../decisions.md#adr-041--persistence-contract).
