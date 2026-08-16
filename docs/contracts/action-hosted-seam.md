---
title: Action ↔ NEAT-host seam
status: proposed
governs: the boundary between the neat-action PR bot (packages/action) and any NEAT host it connects to — a self-hosted daemon or the hosted plane
adr: ADR-187 (the Action), ADR-188 (this seam)
owners: Action side = neat-core (Cem); hosted-plane side = neat-infra (Kurt). This contract is public because it governs public Action code.
reconcile: the hosted-plane specifics below are the Action's requirements, not neat-infra's final design — reconcile with the hosted v1 before locking.
---

# Action ↔ NEAT-host seam

The neat-action posts a verdict-first PR comment (ADR-187). Its verdict is only as good as the host it reads. This contract fixes what the Action sends and what a host must serve, so a **self-hosted daemon** and the **hosted plane** are drop-in interchangeable behind the same client — and so the hosted plane knows exactly what to implement.

## The three customers (the seam serves all three with one client)

| Customer | Host | Config the Action needs | Comment |
|---|---|---|---|
| **neat-local** | none | — | static graph-diff only (no observed breaks — the Action never invents them) |
| **self-hosted** | their own NEAT daemon | `neat-api-url` (their IP/port) + `neat-api-token` | full observed-break verdict |
| **hosted** | the hosted plane | *simple:* `neat-api-url` + `neat-api-token`; *zero-config:* App install + account link | full observed-break verdict |

The verdict logic is identical for self-hosted and hosted — only the host and its auth differ. That is the whole point of pinning this seam: the Action does not branch on which kind of host it's talking to.

## What the Action calls (the host MUST serve these)

Base URL = `neat-api-url` (trailing slashes trimmed). All requests carry `Accept: application/json`, `User-Agent: neat-action`, and — when `neat-api-token` is set — `Authorization: Bearer <token>`. The Action **degrades to the static tier on any error** (non-2xx, unreachable, shape mismatch) and never fails the PR check.

1. `GET /graph/divergences` → declared-vs-observed divergences. The Action keeps the findings whose `source`/`target`/`nodeId` is a node this PR changed. *(Already served by the engine, ADR-060.)*
2. `GET /graph/observed-dependencies/:nodeId` → for each node the PR **removes or changes**, does production actually run it. Response fields the Action reads today: `observed` (bool), `inboundObservedCount` (number — OBSERVED callers), `dependencies` (array — the OBSERVED calls it makes). A node observed at all = an **observed break** if the PR removes/changes it. *(Already served, issue #593.)*

## Auth

`Authorization: Bearer <neat-api-token>`. A self-hosted daemon on the customer's own network sets its own token; the hosted plane issues one per account. Unset → no header (an open host, or the static tier). The token is a workflow **secret**, never a plaintext input.

## What the HOSTED PLANE must add beyond a bare daemon (neat-infra's half)

A daemon serves the two endpoints above for one project. To be the Vercel-style, zero-config, account-linked bot, the hosted plane adds:

- **Account linking + repo→project resolution.** The GitHub App installation maps a repo (and installation id) to the NEAT project whose graph to query, so the zero-config flow needs no `neat-api-url`/`neat-api-token` in the workflow at all — the App holds the account credential and resolves the project.
- **Multi-tenant auth + scoping.** The bearer (or App installation token) scopes to exactly one account's projects; cross-tenant reads must be impossible. This is the security boundary the standalone bot repo exists to isolate (see repo-structure note below).
- **Freshness/availability the verdict can cite honestly.** The `<sub>` line wants "OBSERVED as of Nm ago"; the host should expose graph freshness so the Action states it truthfully rather than guessing.

## Proposed extension — traffic volume (unblocks the punchier verdict)

Today `observed-dependencies` returns dependent **counts**, so the RED line honestly says "4 observed dependents (OBSERVED)". The visceral version — "served **3,214×** in the last 7d, last seen 14m ago" — needs the OBSERVED layer to expose, per dependent edge, an aggregate **call count over a window** and a **last-seen timestamp**. If/when the engine's OBSERVED edges carry that, add `callCount`/`windowDays`/`lastSeenAt` to the `observed-dependencies` response; the Action renders it when present and degrades to counts when absent (never fabricates a number). This is the recommended fast-follow that makes the bot land as a *stop*, not a warning.

## Repo structure (context, not part of the wire contract)

The Action (engine-coupled, tested against real engine snapshots) stays in the monorepo. The **hosted bot service** — account-linking, OAuth, deploy pipeline, customers' production data — belongs in its own repo in the hosted plane (neat-infra), split cleanly on this HTTP seam. The engine's `/graph/*` API is the shared surface both sides hold to.
