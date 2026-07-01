---
name: project-daemon
description: One daemon per project. Each project's daemon owns its own graph, ports, OTLP ingest, REST, dashboard, and MCP surface, and describes itself in <project>/neat-out/daemon.json. Ports are allocated once and reused across restarts. No machine-wide write-locked registry as a coordination point; the global running-daemons list, where present, is append-only and lock-free.
governs:
  - "packages/core/src/daemon.ts"
  - "packages/core/src/neatd.ts"
  - "packages/core/src/cli.ts"
  - "packages/core/src/orchestrator.ts"
  - "packages/core/src/registry.ts"
adr: [ADR-096, ADR-112, ADR-049, ADR-063, ADR-048, ADR-059, ADR-073]
enforcement: [lint, review]
---

# Project-daemon contract

NEAT runs **one daemon per project**. A project's daemon owns that project and nothing else: its graph, its OTLP ingest, its REST API, its dashboard, its MCP surface. This is the same shape the hosted substrate uses per customer/project, so local and hosted are one architecture at two scales (ADR-096).

## 1. One daemon, one project

A daemon is scoped to a single project. It holds that project's graph in memory, persists its snapshot under that project's `neat-out/`, ingests OTel for that project, and serves that project's REST/dashboard/MCP. It has no knowledge of other projects and no shared in-memory slot map. `neat init` and the bare-`<path>` orchestrator spawn a daemon for the project at hand; nothing coordinates across projects.

## 2. Self-description via `neat-out/daemon.json`

Each project's daemon writes `<project>/neat-out/daemon.json` recording its allocated ports (REST, OTLP, dashboard), its pid, and its status. That file is the single source of truth for "where is this project's daemon," read by:

- the instrumentation, to resolve the OTLP exporter endpoint,
- the MCP config (`NEAT_CORE_URL`), to point an agent at the daemon,
- the dashboard, to bind and to open,
- `neat list` / `neat ps`, to report running daemons.

Every process that binds a project's OTLP receiver counts as that project's daemon here and writes this record — the long-lived `neatd` daemon and the `neat watch` dev loop alike. `neat watch` binds REST + OTLP for one project, so it too writes `daemon.json` with the port it actually bound; without it an instrumented app's generated `otel-init` falls back to the default `:4318` and its spans miss a receiver bound elsewhere, darkening OBSERVED for exactly the case the record exists to serve.

Each daemon owns its own `daemon.json` — there is no shared file and no write-lock. A daemon writes its own file atomically (tmp + rename) and reconciles it on exit — graceful *or* otherwise. A graceful `stop()` marks the record `stopped` and clears the discovery copy; an unsupervised exit (crash, fatal signal) reconciles the same way synchronously through a process-exit handler. A dead daemon never leaves a `running` record behind, so a later spawn's reuse check never routes a client at a port nothing is listening on ([ADR-112](../decisions.md#adr-112--daemon-fault-model-otlp-port-stepping-ingest-fault-containment-crash-reconciliation-amends-adr-049--adr-063--adr-096)).

## 3. Ports are allocated once and reused

On first spawn a daemon allocates free ports and persists them to `daemon.json`. On every subsequent spawn it reuses the persisted ports, reallocating only when a port is genuinely held by another process. Stable ports across restarts keep the instrumented app's exporter endpoint (`.env.neat` / `NODE_OPTIONS`) constant — the app is configured once and keeps reaching its project's daemon across daemon restarts.

The canonical defaults (`8080` REST / `4318` OTLP / `6328` dashboard) remain the first-choice ports for a project's daemon; allocation steps to the next free set when the defaults are taken, so a second project's daemon coexists with the first rather than contending for one binding (ADR-112).

A port counts as taken when *either* IP family holds it. A daemon binds one host, but clients reach it through `localhost`, which resolves `::1` (IPv6 loopback) ahead of `127.0.0.1` on macOS and other dual-stack systems. A foreign listener on the IPv6 side of a port the daemon binds only on IPv4 would silently swallow every `localhost` query while the IPv4 probe reads the port as free. So the free-port probe checks both families of the bind interface — loopback probes `127.0.0.1` and `::1`, wildcard probes `0.0.0.0` and `::` — and treats the candidate as taken if a holder sits on either. A family the host genuinely lacks (no IPv6 stack) is not a holder and does not block allocation.

## 4. The project root carries one project

A project's daemon serves its own project at the root of its REST surface. There is no dual-mount and no `default`-project resolution: the daemon is the project, so a request needs no project name to disambiguate, and a query verb against a project's daemon targets that project. Multi-project routing and a machine-wide project switcher belong to the hosted dashboard, which sits above many per-project daemons.

## 5. Per-project dashboard

Each daemon serves its own dashboard on its own port (from `daemon.json`). The dashboard shows that one project. Viewing several projects locally means several daemons, each with its own dashboard — there is no local cross-project switcher.

## 6. Machine-wide discovery is convenience, not coordination

`neat ps` / `neat list` report the daemons running on the machine. Where a machine-wide running-daemons index backs them, it is **append-only and lock-free** — a daemon records its own presence on start and clears it on stop, and the index is a read-optimization for discovery, never a rendezvous other processes must acquire. Losing or rebuilding it costs discovery convenience, not correctness; a project's `neat-out/daemon.json` remains authoritative for that project.

## 7. Lifecycle

`spawn` → allocate-or-reuse ports → bind REST/OTLP/dashboard → write `daemon.json` → ready. A spawn that finds a healthy daemon already serving the project (its `daemon.json` ports answer health) reuses it rather than starting a second. `stop` tears the daemon down and clears its `daemon.json` (and its running-list entry). Idle-project auto-stop (ADR-079 / #365) composes here: a project under no active work need not keep a daemon resident.

## 8. Migration

Installs carrying the machine-level `~/.neat/projects.json` map their registered projects onto per-project daemons on first run under this model: each registered project's path yields a project daemon, and the global file is read once for migration and then retired as a coordination surface. The per-project `neat-out/` is the durable home for each project's snapshot and `daemon.json` thereafter.
