---
name: action-hosted-seam
description: The neat-action reads its verdict from any NEAT host — GET /graph/divergences + GET /graph/observed-dependencies/:nodeId, Authorization Bearer when a token is set, degrading to the static tier on error. One client serves neat-local / self-hosted / hosted; the hosted plane's account-linking, repo→project resolution and multi-tenant scoping are the Action's requirement here, implemented in neat-infra.
governs:
  - "packages/action/**"
adr: [ADR-187, ADR-188, ADR-190, ADR-235]
enforcement: [review]
---

# Action ↔ NEAT-host seam

> **Status:** proposed. **Owners:** Action side = neat-core; hosted-plane side = neat-infra. Public — it governs public Action code. The hosted-plane specifics below are the Action's requirements, not neat-infra's final design — reconcile with the hosted v1 before locking.

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
2. `GET /graph/observed-dependencies/:nodeId` → for each node the PR **removes or changes**, does production actually run it. Response fields the Action reads: `observed` (bool), `inboundObservedCount` (number — OBSERVED callers), `dependencies` (array — the OBSERVED calls it makes), and the node-level **inbound block** `inboundVolume` / `window` / `inboundLastObserved` (ADR-190, §Traffic volume below). A node observed at all = an **observed break** if the PR removes/changes it. *(Already served, issue #593; inbound block ADR-190.)*

## Auth

`Authorization: Bearer <neat-api-token>`. A self-hosted daemon on the customer's own network sets its own token; the hosted plane issues one per account. Unset → no header (an open host, or the static tier). The token is a workflow **secret**, never a plaintext input.

## What the HOSTED PLANE must add beyond a bare daemon (neat-infra's half)

A daemon serves the two endpoints above for one project. To be the Vercel-style, zero-config, account-linked bot, the hosted plane adds:

- **Account linking + repo→project resolution.** The GitHub App installation maps a repo (and installation id) to the NEAT project whose graph to query, so the zero-config flow needs no `neat-api-url`/`neat-api-token` in the workflow at all — the App holds the account credential and resolves the project.
- **Multi-tenant auth + scoping.** The bearer (or App installation token) scopes to exactly one account's projects; cross-tenant reads must be impossible. This is the security boundary the standalone bot repo exists to isolate (see repo-structure note below).
- **Freshness/availability the verdict can cite honestly.** The `<sub>` line wants "OBSERVED as of Nm ago"; the host should expose graph freshness so the Action states it truthfully rather than guessing.

## The zero-config hosted path: the daemon computes the verdict (ADR-235)

The App-installed flow has no workflow file, so nothing runs the Action. The control plane receives the `pull_request` webhook, but the verdict needs the engine — the PR's base and head extracted and diffed before any host is asked about them — and the control plane runs none (neat-infra `tenant-agnostic-core`). So on the hosted path **the tenant daemon produces the comment**:

`POST /pr-verdict` (or `/projects/:project/pr-verdict`), `Authorization: Bearer <project auth token>`, body `{ owner, name, baseSha, headSha, cloneUrl, changedFiles?, tone? }` → `200 { project, marker, body, base, head, changedFiles, observedBreaks, divergences, durationMs }`. `body` carries no marker: the caller stamps its own sticky marker, since a comment carrying the Action's would be taken for the Action's on a repo that runs both. `marker` is the Action's, returned so a caller can recognise an Action comment.

- **Same verdict, same code.** The daemon imports the Action's module (`graph.mjs`) for the diff, the divergence formatting, the observed-break shaping and the renderer. It asks the same two questions this contract lists, of its own live graph in process instead of over HTTP. A change to the verdict lands on both paths at once.
- **What it needs from the caller:** the clone URL with a short-lived installation token, held to `https://github.com/<owner>/<name>` matching the request; full commit SHAs; and, preferably, GitHub's changed-files list for the PR, since depth-1 clones have no merge base.
- **What it guarantees:** both commits are extracted into scratch graphs and discarded with their checkouts; the live graph is only read; the token never reaches disk, a log or a response; one verdict at a time (`429` + `Retry-After` otherwise); a wall-clock limit (`504`); a failed clone or extraction is `422` with the `stage` that failed.
- The control plane posts `body` as the PR's comment. Account linking, repo→project resolution and the comment's lifecycle stay in the hosted plane, as above.

## Traffic volume and recency — the node-level inbound block (ADR-190, shipped)

`observed-dependencies` carries a node-level **inbound block** so the RED line can say "served **1,000×** (lifetime), last seen 14m ago" instead of only "4 observed dependents":

- `inboundVolume` — aggregate production call volume *into* the node (summed inbound-edge count). Distinct from `inboundObservedCount`, which is the *number* of inbound edges.
- `window` — the label for `inboundVolume` (`"7d"` | `"lifetime"`). The OBSERVED signal is cumulative today, so the honest label is `"lifetime"`.
- `inboundLastObserved` — when production last *called* the node, **raw ISO8601**, never pre-formatted.

The Action pushes these onto the break object under **new keys** — never overwriting the break object's existing `callCount` (its outbound `dependencies.length`) or `dependentCount` (`inboundObservedCount`) — and renders "served {inboundVolume}× {windowLabel}, last seen {age}" when present. **Honesty rules, non-negotiable:** recency comes raw and is formatted in the renderer; the window label prints only when the API's `window` names it (a lifetime count is never rendered as "in 7d"); and when the fields are absent the Action degrades to "N observed dependents" — it never fabricates a volume or a window.

ADR-188 first sketched this fast-follow as per-edge `callCount` / `windowDays` / `lastSeenAt`; **ADR-190 refined it to the node-level block above and this contract is amended to pin those names**. The verdict's question is *how hard and how recently production hit the changed node* — an inbound aggregate on the node, not a property of any one dependent edge — and reusing `callCount` would collide with the break object's existing key.

## Repo structure (context, not part of the wire contract)

The Action (engine-coupled, tested against real engine snapshots) stays in the monorepo. The **hosted bot service** — account-linking, OAuth, deploy pipeline, customers' production data — belongs in its own repo in the hosted plane (neat-infra), split cleanly on this HTTP seam. The engine's `/graph/*` API is the shared surface both sides hold to.
