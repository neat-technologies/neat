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

ADR-279, ruled by Deniz on 2026-11-16 (neat-infra #293): a finding's newness is detected in the daemon, every divergence type and every reachable vulnerability qualifies, a finding is tried again when the code changes, a cleared finding is recorded, findings already present when the ledger starts do not trigger, a vulnerability is recorded against the default branch only, and at the bound the oldest rows are dropped.

## 1. What qualifies

- **A divergence:** every type `computeDivergences` returns.
- **A vulnerability:** a security card whose reachability level is `reachable-static` or `reachable-observed`. `imported` and `present` do not qualify.

## 2. Identity

- `findingId` is the no-regression gate's (ADR-277): `sha256("divergence\0" + divergenceIdentity)` for a divergence, the gate's vulnerability finding id for a vulnerability. One function serves the gate and this ledger.
- A row's `affectedNode` is the gate's: the divergence's declaring side, and for a vulnerability the node it points at by fix type ([`no-regression-gate.md`](./no-regression-gate.md), ruled 2026-11-21, #1751), which is the importing service for a bump and the first first-party caller otherwise.
- The commit is the `ready` `sourceBaselines` entry of the repository that declares the affected node ([`source-baseline.md`](./source-baseline.md)). For a vulnerability the repository is the importing service's, whichever node it points at. No `ready` baseline, no record.
- A vulnerability is recorded against the default-branch baseline only.
- The ledger key is `(findingId, sha)`.

## 3. The ledger

- `<project>/neat-out/findings.ndjson`, append-only, one row per key, written through the scrubbing ledger writer.
- A row is `{ findingId, kind: 'divergence' | 'vulnerability', affectedNode, repository, sha, firstSeenAt, divergenceType?, advisoryId? }` and nothing else. No reason, locus, evidence, message or source.
- A key already in the ledger is never written again while the finding stays present.
- **Cleared.** When a finding recorded as present is absent at an evaluation, one `{ findingId, kind, sha, clearedAt, cleared: true }` row is appended. If it returns, it is a first appearance again and gets a new row.
- **Baseline.** The first evaluation after the ledger is created writes the findings then present with `baseline: true`. A baseline row is never served on the stream and never emitted as an event.
- **Bound.** 16 MiB or 10,000 rows. At the bound the rows of the oldest commits are dropped first.

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
- A finding that clears gets one `cleared` row, and one that returns is recorded as a first appearance again.
- The findings present when the ledger is created are written as baseline rows, and none of them is emitted or served on the stream.
- At the bound the oldest commits' rows are dropped and the stream still serves.
- The same finding at a new commit is recorded once more.
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
