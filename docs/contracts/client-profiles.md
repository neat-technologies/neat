---
name: client-profiles
description: One profile — { endpoint, authToken? } — is how every NEAT client (GUI, CLI, MCP) reaches a daemon. Talk to the daemon at its root (ADR-096). Resolution precedence is explicit-profile → NEAT_CORE_URL override → local daemon discovery → loopback. Reads are profile-routable to any endpoint including hosted; local mutations stay local. The profile source is the only local↔hosted swap point.
governs:
  - "packages/core/src/cli-client.ts"
  - "packages/core/src/cli.ts"
  - "packages/mcp/src/base-url.ts"
  - "packages/web/lib/resolve-project.ts"
adr: [ADR-102, ADR-101, ADR-096, ADR-073]
---

# Client profile contract

Every NEAT client — the GUI, the `neat` CLI, the `neat-mcp` server — reaches a daemon through one **profile**. A profile is how a client answers "which NEAT am I talking to," and it is the same shape and the same code path whether the daemon is a local per-project daemon or a hosted one. This is the canonical local↔hosted seam (ADR-102), generalizing the web profile of ADR-101 to every client.

## 1. Profile = `{ endpoint, authToken? }`

A profile is exactly two fields: the daemon's REST `endpoint` and an optional bearer `authToken`. A client's API base **is** the selected profile's `endpoint`. No client branches on local-vs-hosted; the difference is carried entirely by the profile's values — a loopback endpoint with no token, or a hosted endpoint with one.

## 2. Talk to the daemon at its root

A daemon serves its one project at the REST root (`GET /graph`, not `/projects/:name/graph`) per the project-daemon contract (ADR-096). A profile `endpoint` is therefore a daemon **root**; the project *is* the daemon, and its name is only the profile's label.

The CLI's `/projects/:name` prefix (`cli-client.ts` `projectPath`, cross-cutting rule 7 / ADR-026) is the pre-ADR-096 dual-mount path; it reconciles to root-addressing as the daemon refactor lands. New client code targets the profile endpoint root.

## 3. Resolution precedence (CLI + MCP)

A client with no explicit selection resolves its profile in this order, falling through on each miss. This extends the existing `NEAT_CORE_URL → daemon.json → loopback` chain (`mcp/base-url.ts`) with profile selection on top, keeping the primitives:

| # | Source | Yields |
|---|--------|--------|
| 1 | `--profile <name>` (CLI) / `NEAT_PROFILE` (env) | the named profile from the per-user store (§4) |
| 2 | `NEAT_CORE_URL` (+ `NEAT_AUTH_TOKEN`); `NEAT_API_URL` honored as alias | an ad-hoc unnamed profile — the explicit pin the hosted/prod substrate uses |
| 3 | nearest `neat-out/daemon.json` walking up from cwd | `{ endpoint: http://localhost:<ports.rest> }`, no token — the local project daemon |
| 4 | none of the above | `{ endpoint: http://localhost:8080 }` — loopback default |

Resolution never throws: a missing, malformed, or `status:"stopped"` daemon record falls through to the next level. The GUI's resolution (URL `?project=` → `localStorage` → daemon discovery → null, ADR-101 / [`web-multi-project.md`](./web-multi-project.md)) is the web-side instance of the same idea — choose a profile, then talk to its endpoint.

## 4. Named profiles are a client address book, not a daemon registry

Named profiles persist in `~/.neat/profiles.json` — a per-user list of the remote NEATs this machine talks to. It is a **client** config:

- Daemons never read it and never coordinate through it.
- It is not a rendezvous; losing or rebuilding it costs convenience, not correctness.
- It does not reintroduce the shared coordination registry ADR-096 leaves behind. That rule governs how daemons coordinate; a client's address book is orthogonal.

Each entry is `{ name, endpoint, authToken? }`. The token may be stored or sourced from the environment / a secret store — and is never written to a snapshot or a graph (cross-cutting rule 13 in spirit).

## 5. Remote mode — reads route, local mutations stay local

| Surface | Mode | Why |
|---|---|---|
| Read/query verbs (`root-cause`, `blast-radius`, `dependencies`, `observed-dependencies`, `incidents`, `search`, `diff`, `stale-edges`, `policies`, `divergences`) and the read MCP tools | **profile-routable** | REST GET/POST against a daemon — works against any endpoint, including a hosted one with a bearer. This is "run OBSERVED queries against hosted NEAT from the terminal / point an agent at hosted." |
| `neat init`, `neat watch`, the bare-`<path>` orchestrator, the `/neat extend` operative tools, the SDK installers | **local-only** | They mutate the local filesystem and spawn or instrument a local daemon. They ignore a remote profile and never silently target one. |
| `neat sync --to <url\|profile>` | **deliberate remote write** | The one write that crosses to a remote daemon: pushes a freshly extracted snapshot (ADR-074). `--to` may name a profile. |

A read verb run against an unreachable profile exits `3` (daemon not reachable), the same as local ([`cli-surface.md`](./cli-surface.md)). A profile-routable surface targets the selected endpoint only — a stale or dead profile is reported, never silently swapped for a different endpoint.

## 6. Auth is per-profile and single-sourced

The bearer travels as `Authorization: Bearer <token>` on REST and SSE; OTel exporters send the same header (ADR-073). Every read site reads the token from the one resolver (`resolveAuthToken`), so a new client call site cannot quietly skip auth. A loopback local profile omits the token — a loopback daemon stays reachable without one; a hosted profile carries it.

## 7. The profile source is the only local↔hosted swap point

- **Local:** enumerate per-project daemon discovery — `neat-out/daemon.json` for the cwd project (CLI/MCP), the machine-wide running-list for the GUI switcher — one profile per running daemon.
- **Hosted (additive, later):** the platform's project list, each entry an `{ endpoint, authToken }`.

Same clients, same resolution, same request code. Hosted adds a source and a token; it does not fork the client. Building every client to this contract is what lets hosted hook in with no rewrite.

## Authority

`packages/core/src/cli-client.ts` (the shared REST helper + `resolveAuthToken`) and `packages/core/src/cli.ts` (profile selection / `--profile`) for the CLI; `packages/mcp/src/base-url.ts` for the MCP server; the web profile resolver (`packages/web/lib/resolve-project.ts`, ADR-101) for the GUI. The per-user store at `~/.neat/profiles.json`. The CLI client and the MCP client share one REST helper module — one endpoint surface, two consumers.

## Enforcement

`it.todo` until the implementation wave. Regression tests cover: the four-level precedence and fall-through; reads route to the selected endpoint and never swap on failure; local-only verbs ignore a remote profile; the bearer is attached from the single resolver on every routed read; `~/.neat/profiles.json` is read by clients only — no daemon code path reads it.

Full rationale: [ADR-102](../decisions.md#adr-102--one-profile-seam-for-every-client-gui--cli--mcp-and-remote-mode).
