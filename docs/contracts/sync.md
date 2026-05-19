---
name: sync
description: `neat sync` is the third top-level verb. Re-runs the orchestrator subset that responds to a moving project layout — discovery + extract + SDK apply + daemon notify — and skips the first-run-only steps (registry register, browser open, first-run summary). Behaviour branches on daemon state; exit codes mirror the orchestrator.
governs:
  - "packages/core/src/cli.ts"
  - "packages/core/src/orchestrator.ts"
adr: [ADR-074, ADR-073, ADR-046, ADR-048, ADR-049]
---

# `neat sync` contract

The third top-level verb on the CLI, alongside `neat <path>` (one-command orchestrator, ADR-073 §1) and `neat deploy` (ADR-073 §2). `neat sync` answers the minute-six question the orchestrator's one-shot shape leaves open: the project layout has moved, the operator wants the live graph to catch up, no new substrate or first-run rituals required.

Five sections, one rule each.

## 1. The verb re-runs the orchestrator subset that matters when the project moves

`neat sync` invokes — in order — the same primitives `neat <path>` calls, restricted to the steps that respond to layout change:

1. **Discovery + extraction** (per [`static-extraction.md`](./static-extraction.md)). Walks the registered project root, rebuilds the static slice of the graph.
2. **SDK install apply** (per [`sdk-install.md`](./sdk-install.md) and [`framework-installers.md`](./framework-installers.md)). Picks up any new services introduced since the last run; idempotent on packages already instrumented.
3. **Daemon notify**. Signals the running daemon (per [`daemon.md`](./daemon.md)) to reload the project's graph from the freshly written snapshot.

The verb is **distinct from `neat <path>`** — its consent shape is "the project has moved, catch up the graph," not the first-run "make this work end-to-end." It shares primitives with the orchestrator but not the first-run-only steps named in §2.

## 2. The verb explicitly skips the first-run-only steps

`neat sync` does **not** run:

- **Project registration** ([`project-registry.md`](./project-registry.md)). The project is already registered; re-registering would either no-op or surface as a confusing "already registered" warning. `neat sync` refuses to run against an unregistered path with exit code 1 and a message pointing the operator at `neat <path>` or `neat init`.
- **Daemon spawn**. `neat sync` neither starts the daemon nor restarts it. The daemon is the operator's long-running surface; spawning it from a sync call would confuse the lifecycle.
- **Browser open**. The operator already has the dashboard open from the first-run `neat <path>` invocation. Re-opening on every sync would be aggressive.
- **First-run summary block**. The orchestrator's one-screen summary (per ADR-073 §1) targets the cold-clone experience. `neat sync` emits a one-line delta summary instead — counts of services / edges added or removed — and exits.

## 3. Behaviour branches on whether the daemon is running

**Daemon running** (REST `:8080` responds to `/healthz` within the orchestrator's standard probe window):

- `neat sync` writes the new snapshot to `<projectDir>/neat-out/graph.json` (per [`persistence.md`](./persistence.md)).
- Signals the daemon to reload via the existing project-reload path (the same path `neat watch` uses on snapshot rewrites).
- Exit code `0` on clean reload.

**Daemon down** (no response, or the response is non-200):

- `neat sync` still writes the fresh snapshot to disk — the static slice is the ground truth even without a running daemon.
- Prints a soft warning: `neat sync: daemon not running; snapshot updated, run \`neatd start\` to serve it`.
- Exit code `2` (soft warning — completed, but the operator should know).
- Does **not** spawn the daemon. `neatd start` and `neat <path>` are the two verbs that own daemon spawn; `neat sync` deliberately stays out of that lifecycle.

## 4. Flags and project selection

`neat sync` invoked inside a registered project directory: defaults to that project.

`neat sync --project <name>`: selects a registered project by name (per [`project-registry.md`](./project-registry.md)). Useful when the operator is outside the project directory (CI, scripted sync from a parent automation).

Flags:

- `--dry-run` — runs discovery + extract in-memory, prints the planned snapshot delta, exits without writing the snapshot or notifying the daemon. Mirrors `neat init --dry-run`.
- `--no-instrument` — skips the SDK install apply step. Useful when the operator has a manual instrumentation workflow they want preserved. Mirrors `neat <path>`'s `--no-instrument`.
- `--json` — emits the delta summary as a structured JSON payload on stdout instead of the human-readable line. Mirrors the [`cli-surface.md`](./cli-surface.md) `--json` convention.

`neat sync --help` lists the subset and links to the orchestrator verb for first-run questions.

## 5. Exit codes mirror the orchestrator

- `0` — clean re-sync. Snapshot written, daemon notified (or daemon-down warning printed cleanly).
- `1` — fatal error. Unregistered path, discovery or extraction failure, snapshot write failure, registry read failure.
- `2` — soft warning that still completed. Daemon-down branch is the canonical case; SDK apply with conflicts the operator should review (preserved existing files, manifest edits that couldn't be reconciled) also lands here.

Exit codes match [`cli-surface.md`](./cli-surface.md)'s `0` / `1` / `2` convention so wrappers around the verb (CI jobs, parent automations) can branch on the same shape they use for every other CLI verb.

## Authority

- `packages/core/src/cli.ts` — `neat sync` verb registration, flag parsing, project-name resolution, exit-code branching, soft-warning print path.
- `packages/core/src/orchestrator.ts` — the re-runnable subset extracted as a named function (the sync verb calls into it). Existing `runOrchestrator` retains its first-run shape; the shared sub-pipeline (discovery + extract + apply + daemon notify) is the surface `neat sync` reuses.

## Enforcement

`describe('ADR-074 — neat sync + env-dimension + framework installers')` → nested `describe('§1 neat sync verb')` in `packages/core/test/audits/contracts.test.ts`. Assertions land alongside the implementing PR; pre-implementation rows surface as `it.todo`.

Full rationale: [ADR-074](../decisions.md#adr-074--neat-sync-env-dimension-at-ingest-framework-installer-paths).
