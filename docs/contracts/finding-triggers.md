---
name: finding-triggers
description: The daemon records the first time a qualifying finding (any divergence, a reachable vulnerability) is present at a commit, as one source-free ledger row and one `finding` bus event, and serves those rows on an authenticated, replayable trigger stream beside the incident one.
governs:
  - "packages/core/src/findings-ledger.ts"
  - "packages/core/src/streaming.ts"
  - "packages/core/test/finding-triggers*.test.ts"
adr: [ADR-279, ADR-277, ADR-221, ADR-060, ADR-051]
enforcement: [lint, review]
---

# Finding triggers contract

Proposed with ADR-279. Deniz ruled on 2026-11-16 (neat-infra #293) that a finding's newness is detected in the daemon, that every divergence type and every reachable vulnerability qualifies, and that a finding is tried again when the code changes. The mechanism below is proposed for his review; the open points are in the ADR.

## 1. What qualifies

- **A divergence:** every type `computeDivergences` returns.
- **A vulnerability:** a security card whose reachability level is `reachable-static` or `reachable-observed`. `imported` and `present` do not qualify.

## 2. Identity

- `findingId` is the no-regression gate's (ADR-277): `sha256("divergence\0" + divergenceIdentity)` for a divergence, the gate's vulnerability finding id for a vulnerability. One function serves the gate and this ledger.
- The commit is the `ready` `sourceBaselines` entry of the repository that declares the affected node ([`source-baseline.md`](./source-baseline.md)). No `ready` baseline, no record.
- The ledger key is `(findingId, sha)`.

## 3. The ledger

- `<project>/neat-out/findings.ndjson`, append-only, one row per key, written through the scrubbing ledger writer.
- A row is `{ findingId, kind: 'divergence' | 'vulnerability', affectedNode, repository, sha, firstSeenAt, divergenceType?, advisoryId? }` and nothing else. No reason, locus, evidence, message or source.
- A key already in the ledger is never written again.

## 4. When the daemon evaluates

- After `extraction-complete`, a `stale-transition`, an OBSERVED `edge-added`, and each dependency-loop tick, debounced.
- Evaluation calls the pure queries and writes only to the ledger. It never mutates the graph.
- `computeDivergences` and the security card composition are not changed and persist nothing (ADR-060).

## 5. The event

- A tenth bus event, `finding`, whose payload is the ledger row. It is emitted after the row is appended, and on a hosted daemon after the sidecar has committed it.

## 6. The stream

- `GET /projects/:project/finding-triggers`, with the dedicated stream token of [`incident-trigger-stream.md`](./incident-trigger-stream.md): at least 32 bytes, different from the general token, unavailable without it.
- `event: finding`, `id: <findingId>:<sha>`, the row as data.
- `X-NEAT-Event-Scope: finding-only-v1`, with `X-NEAT-Project` and `X-NEAT-Replay-Complete: 1`. A reader requires all three and refuses a `finding` frame seen on any other stream.
- Replay is from the ledger after the exact `Last-Event-ID`. An unknown cursor, a corrupt ledger or a ledger above the bound refuses the stream.
- Unavailable by default, under the same durability assertion as the incident stream.
- The incident stream is unchanged, and a `finding` never appears on it.

## 7. Tests

- A finding present at a commit is recorded once, however many evaluations run.
- The same finding at a new commit is recorded once more. A finding that clears and returns at a recorded commit is not.
- No `ready` baseline: nothing is recorded, and it is recorded once the baseline is ready.
- A vulnerability at `imported` is not recorded, and is recorded when it becomes `reachable-static`.
- The gate's `findingId` for a divergence equals the ledger's for the same divergence.
- A row carries only the listed fields.
- The stream replays after a cursor, refuses an unknown one, and never carries an incident.
- `computeDivergences` on the same graph returns the same result before and after an evaluation.

## Not in this contract

- Starting a run, retry limits and the open-pull-request check: the control plane (neat-infra #293).
- What a finding says: the reader asks the graph (neat-sniper #66).
- Findings on a ref view.
