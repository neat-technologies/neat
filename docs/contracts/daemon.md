---
name: daemon
description: Single long-lived process watching every registered project. Per-project graph isolation. File-mtime + OTel + policy.json triggers. REST + OTLP binding is the observable contract surface. Graceful per-project failure. Self-hosting gate stays closed during v0.2.5.
governs:
  - "packages/core/src/daemon.ts"
  - "packages/core/src/neatd.ts"
  - "packages/core/src/cli.ts"
  - "packages/core/src/ingest.ts"
  - "packages/core/src/extract/index.ts"
  - "packages/core/src/persist.ts"
adr: [ADR-049, ADR-063, ADR-112, ADR-048, ADR-026, ADR-027, ADR-071, ADR-072, ADR-130]
enforcement: [lint, review]
---

# Daemon contract

The fourth of four v0.2.5 distribution-layer contracts. Sibling contracts: [`init.md`](./init.md), [`sdk-install.md`](./sdk-install.md), [`project-registry.md`](./project-registry.md).

The daemon is what makes the graph **continuous**. Without it, `init` snapshots once and the user re-runs extraction manually. With it, edits to source, OTel arrivals, and policy changes drive ongoing graph mutation across every registered project — without per-project `neat watch` invocations.

## Single long-lived process

`neatd start` boots one daemon watching every project in `~/.neat/projects.json`. Per-project graphs in `Map<string, NeatGraph>` per ADR-026. No clustering in MVP.

## Lifecycle commands

| Command | Effect |
|---------|--------|
| `neatd start [--foreground]` | start the daemon (default backgrounds via nohup/launchd/systemd; user runs it manually in MVP) |
| `neatd stop` | graceful shutdown. Flush per [persistence.md](./persistence.md), release lock, exit |
| `neatd reload` | re-read `~/.neat/projects.json`. Pick up new projects, drop removed ones |
| `neatd status` | print PID, registered projects, last-seen timestamps |

## Continuous extraction triggers

Per project, daemon watches:

- **Source file mtimes** via chokidar — re-extract phase per [static-extraction.md](./static-extraction.md).
- **`policy.json` mtime** — reload policies per [policy-schema.md](./policy-schema.md).
- **`compat.json` mtime** in NEAT's install dir — reload matrix; re-evaluate compatibility policies.
- **OTel HTTP/gRPC ingest** on `:4318` / `:4317` — `handleSpan` per [otel-ingest.md](./otel-ingest.md).
- **Staleness loop** per ADR-024 — every 60s.

## Per-project isolation

Each project's graph is its own `MultiDirectedGraph`. File watching, OTel ingest, policy evaluation scoped to the project. A failure in one project does not affect others.

## Binding observability (ADR-063)

After `neatd start` returns success, the daemon process is reachable through the documented surfaces. "Reachable" is what the contract asserts; "bootstrapped" is not enough.

- **REST host on `:8080`.** One Fastify listener, multi-tenant. Every registered project answers under `/projects/:project/*` per the ADR-026 dual-mount. The default project additionally answers the unprefixed legacy paths (`GET /graph`, `GET /graph/divergences`, etc.).
- **OTLP HTTP receiver on `:4318`.** Single-instance, multi-tenant. Span routing happens at handler time via `routeSpanToProject(serviceName, projects)` — already exported. Spans for unknown services route to the `default` project's FrontierNode flow per ADR-033.
- **Bind happens within 30 seconds** of the `startDaemon` promise resolving. The deadline tracks the upper bound of realistic bootstrap time on a moderate-multi-project registry, not the lower bound.
- **REST bind failure is fatal.** `EADDRINUSE`, permission denied, or any other REST listen failure aborts `neatd start` with a non-zero exit and a clear error message. Silent fallback to "the supervisor is running but no listeners are bound" is the v0.3.0 failure mode this contract exists to close. The REST port is the daemon's identity for the spawn-reuse `/health` check (project-daemon §7), so it never moves silently under a client.
- **A held OTLP receiver port steps to the next free one, it does not crash the daemon (ADR-112).** `:4318` is the OS-default OTLP port a foreign collector commonly holds, and the per-project allocator can only probe it *before* spawn — a holder that arrives in the race between allocate and bind, or a bare `neatd start` on a busy machine, would otherwise take the whole OBSERVED layer down. Every OTLP consumer resolves the port dynamically from `daemon.json` `ports.otlp` (project-daemon §2/§3), so the receiver steps to the next free port on `EADDRINUSE` and records the port it actually bound. This is not the "half-up, nothing bound" failure the fatal clause exists to close — the receiver *is* bound and discoverable. Only a non-`EADDRINUSE` failure (permission denied) or an exhausted step window aborts `neatd start`.
- **`NEAT_WEB_DISABLED=1` skips the web UI only.** REST and OTLP bind unconditionally — CLI and MCP consumers depend on the REST host being live.
- **`PORT` and `OTEL_PORT` env vars override** the default ports (`8080`, `4318`) symmetrically with `server.ts`. Same env contract as `neat watch`.

The OTLP/gRPC receiver on `:4317` stays opt-in via `NEAT_OTLP_GRPC=true` per the existing ADR-049 routing section. Only `:4318` is part of the binding contract.

## OTel routing

Spans route to a project by `service.name` lookup across registered projects. Spans for unknown services route to a fallback `'default'` project for FrontierNode auto-creation per ADR-033.

`routeSpanToProject(serviceName, projects)` matches in three passes (ADR-072):

1. **Exact** — `entry.name === serviceName`.
2. **Token prefix** — `entry.name` is the first hyphen/underscore-separated token of `serviceName`. `brief` matches `brief-api`, `brief_worker`; `briefcase` does not match `brief`. Longest project name wins (so `brief-api` outranks `brief` when both are registered and the span says `brief-api-staging`).
3. **Token containment** — `entry.name` appears as a separator-delimited token inside `serviceName`. `api` matches `brief-api-staging` only when no prefix match was found.

Routing eligibility by status:

- `active` matches by `service.name` at every pass (steady state).
- `broken` also matches at every pass. The router selects the broken slot so the ingest-time recovery path (below) can attempt a single re-bootstrap before the span is dropped. If recovery fails, the span is dropped with a rate-limited warning that points at `neatd reload`.
- `paused` never matches — the operator paused the project on purpose. The span falls through to the `default` project's FrontierNode flow per ADR-033.

## Ingest-time recovery for broken projects (ADR-071)

A broken project slot is recoverable territory. When a span arrives for a project whose slot is `broken`, the daemon attempts a single inline re-bootstrap via `bootstrapProject(entry)`:

- Success → the slot transitions to `active`, its `status` updates in the registry via `setStatus`, the span lands as a normal OBSERVED edge.
- Failure → the slot stays `broken`, the span is dropped, and the receiver logs a single warning per project per 60 seconds carrying the original error reason and the `neatd reload` hint.

Per-project recovery never affects other slots. The recovery attempt runs the same `bootstrapProject` path used at daemon start, so any rule that holds at bootstrap holds on recovery.

## SIGHUP rebuilds broken slots

`neatd reload` re-reads the registry. New entries get bootstrapped, removed ones get their persist loops stopped, **and any slot currently in `broken` is re-bootstrapped** — the operator's mental model for `reload` is "look at the world again," which includes giving broken slots a second chance against the current disk state. Already-`active` slots are left in place.

## Graceful degradation

- Registry file missing → daemon refuses to boot with a clear error.
- Project path missing → mark `status: 'broken'`, continue with others. The ingest-time recovery path retries on the next span; SIGHUP reload also retries.
- OTel ingest overwhelmed → backpressure via the queue (ADR-033 #1); spans drop, never block.
- Span arrives for a broken project, recovery still fails → drop with a rate-limited warning (1 line per project per 60s) carrying the broken-state reason and the `neatd reload` hint. Never silent.

## Fault containment — a rejected promise never takes the daemon down

An escaped promise rejection from the ingest path — a rejection that slips past the drain loop's own error handling — is contained, not fatal. The daemon installs an `unhandledRejection` handler that logs the fault loud (error + stack, never silent) and keeps serving, so one bad span or one bug in an async ingest branch does not dark the whole OBSERVED layer for every project. This extends the per-project-isolation guarantee to the process boundary: a stray rejection is the smallest possible blast radius, not the death of the daemon.

An `uncaughtException` is a different class of fault and stays fatal. A synchronous throw that reaches the top of the stack leaves the process in an undefined state, so the daemon logs it loud and exits non-zero rather than serve from possibly-corrupt state — supervision restarts it clean. The bind-failure paths are fatal for the same reason: a daemon that cannot bind its listeners is not serving anything and must exit loud. Fault model per [ADR-112](../decisions.md#adr-112--daemon-fault-model-otlp-port-stepping-ingest-fault-containment-crash-reconciliation-amends-adr-049--adr-063--adr-096).

## Crash safety and self-description reconciliation

PID at `~/.neat/neatd.pid` for external supervisors. The daemon does not respawn itself; supervision is the supervisor's job. It does, however, reconcile its own self-description on exit — graceful *or* otherwise. A daemon that goes down for any reason marks its `neat-out/daemon.json` `status: 'stopped'` and clears its machine-wide discovery copy synchronously on process exit, so a dead daemon never leaves a `running` record pointing clients at a port nothing is listening on. The graceful `stop()` path does this first; the process-exit handler is the backstop for the unsupervised case (ADR-112).

## Self-hosting gate stays closed

Per ADR-027 + the v0.2.x sequencing: self-hosting NEAT on the NEAT codebase only flips on after the MVP-success PR closes. The daemon contract specifies how self-hosting *would* work; running it on the NEAT codebase is post-#126.

## Authority

`packages/core/src/daemon.ts`. Composes:
- `registry.ts` — reads `~/.neat/projects.json`.
- `extract/*` — re-extraction triggers.
- `ingest.ts` — OTel ingest routing.
- `policy.ts` — policy reload + evaluation triggers.
- `persist.ts` — per-project snapshot writes.

## Enforcement

`packages/core/test/audits/contracts.test.ts` under `Daemon contract (ADR-049)`:

- Daemon writes `graph.json` only via `persist.ts` loop and shutdown handlers.
- Per-project graph isolation: failure in one project does not affect others.
- OTel span routing matches by `service.name` across registered projects.
- Missing registry refuses to boot with a clear error.
- Daemon writes PID to `~/.neat/neatd.pid`.
- SIGHUP triggers registry re-read.
- ADR-063 binding contract: REST `:8080` bound within 30s of `startDaemon` resolving.
- ADR-063 binding contract: OTLP `:4318` bound within 30s of `startDaemon` resolving.
- ADR-063 binding contract: every registered project answers `GET /projects/:project/graph` with 200.

Full rationale: [ADR-049](../decisions.md#adr-049--daemon-contract), [ADR-063](../decisions.md#adr-063--neatd-start-binds-rest-and-otlp-per-project-amends-adr-049).
