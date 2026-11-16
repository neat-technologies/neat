---
name: ref-views
description: A project keeps one live runtime layer and, per repository, memory-only static layers keyed by git state. A read with `?ref=` is answered from a view that fuses the ref's static layer with the live graph as it stands when the request starts, and it reports how many runtime edges it had to hide. Slice one only - see "Not in this contract".
governs:
  - "packages/core/src/ref-registry.ts"
  - "packages/core/src/extract/ref-view.ts"
  - "packages/core/test/ref-view*.test.ts"
adr: [ADR-278, ADR-233, ADR-093, ADR-094]
enforcement: [lint, review]
---

# Ref views contract (slice one)

Ruled by Deniz on #1698: the layered model, live runtime, memory-only retention, the working tree as the local default and HEAD plus a digest as dirty identity (2026-11-15), and (c) with ownership recorded on the graph (2026-11-16, relayed by the orchestrator). Incomplete layers are served with their counts (§4, ADR-278 decision 4a, 2026-11-16). Numbers marked *(one run)* are ADR-278's evidence: gitea, opentelemetry-demo and a two-repository project, one run each.

## 1. Keys

- **Commit state:** `commit:<40-hex sha>`.
- **Worktree state:** `worktree:<sha>+<sha256 dirty digest>`. A clean worktree is `commit:<sha>`.
- **Branch and tag names** resolve to a SHA when a layer is built and are never keys.
- **A static layer's key** is `(project, repository, state)`. `repository` is `owner/name` exactly as `sourceBaselines` spells it.

## 2. Placement (substrate.md layers)

- **`ref-registry.ts` (substrate):** the per-project map of retained static layers, LRU and TTL, pins, and the shared build promise per key. It holds graphs; it never writes into one.
- **`extract/ref-view.ts` (producers):**
  - Building a static layer: `extractFromDirectory` into a fresh graph, scoped by `source` to the repository (ADR-233).
  - Composing a view (copy and merge).
  - Every graph write stays with the producers, as `lifecycle.md` requires, even on in-memory graphs.
- **Read routes (surfaces)** take the `ref` parameter. Queries (`traverse.ts`, policy, divergences, card) are not changed.

## 3. The runtime layer

- **Contents:** in slice one, the live graph's runtime subset, derived by provenance when a view is composed:
  - OBSERVED, INFERRED, STALE and FRONTIER edges and their endpoint nodes
  - nodes with `discoveredVia: 'otel'`
  - runtime attributes on static nodes: a ServiceNode's `env`, `observedImage`, `observedReadyReplicas` and `discoveredVia: 'merged'`, and an InfraNode's non-EXTRACTED column provenances
- **Writes:** ingest, connectors and the staleness loop write to the live graph only. **Nothing writes to a static layer or a view after it is built.**

## 4. Static layers

- **Building:**
  - A layer is built on request from a checkout of exactly the keyed state.
    - Hosted: a clone at the SHA, credential as pr-verdict mints it.
    - Local: git at the project's `scanPath`.
  - A build with extraction errors or skipped files is `incomplete`. An incomplete layer is served, with `{ extractionErrors, skippedFiles }` in the `ref` block of every answer (ADR-278 decision 4a).
- **Concurrency:** builds are asynchronous and idempotent per key. Two requests for one key share one build.
- **Retention:**
  - Memory only, never snapshotted.
  - A fixed count per project, least recently read evicted first, and a TTL since last read. The numbers are set from measured layer size before release: ~3 MB per 4k-node layer *(one run)*.
  - A pinned layer (a running Sniper attempt, an open follow session) is not evicted.

## 4a. Ownership

- A view reads ownership from `declaredBy` ([`static-extraction.md`](./static-extraction.md), #1730). It removes a static element only when the ref's repository is its sole recorded declarer.
- An element with no recorded declarer is unknown and is treated as someone else's, so it stays.

## 5. Views

1. **Composition.** A view is a copy of the ref's static layer, plus the live static layers of the project's other repositories, plus the runtime layer.
   - Node attributes: the static layer's declared fields, with runtime fields carried over.
   - A runtime-discovered node is added.
   - A static-owned node the ref lacks is never added.
   - A runtime edge is added only when both endpoints are in the view.
2. **Freshness.**
   - A request resolves its view once, at its start: the cached view if the live graph's mutation counter equals the value at compose, otherwise a fresh compose (1–3 ms single-repo, 20 ms at 12k nodes over two repos *(one run)*).
   - **Every step of that request reads the same view object, across awaits. Nothing recomposes mid-request.**
   - A view is never built from runtime older than its request's start.
   - Only static layers are retained. A view lives while a request holds it or until it's replaced.
3. **Hidden runtime count.** Every answer from a view carries `ref: { key, hiddenRuntimeEdges }`, where `hiddenRuntimeEdges` is the number of runtime edges left out by rule 1. The count travels in the body, so agents see it (paired `@neat.is/types` change).
4. **Baseline.** A view's `sourceBaselines` entry for its repository is the layer's own: `{repository, status, sha, state: 'commit' | 'worktree', dirtyDigest?}`.

## 6. REST

- **`POST /projects/:p/refs`** `{ repository, sha }` returns `{ ref, status: building | ready | incomplete | failed }`.
- **`GET /projects/:p/refs`** lists the retained layers with key, status and age. No graph content.
- **Read routes:** `/graph`, `/graph/node/:id`, blast radius, dependencies, root cause, divergences and the incident card accept `?ref=<key>`.
- **`POST /policies/check`** accepts `?ref=<key>` too (ruled by Deniz 2026-11-16, #1745): the policies are evaluated on the view, so a pull-request-triggered run checks policy on the pull request's own code. The policy file is the project's own, never the ref's. The same refusals apply.
  - With no `ref`, they read the live graph as today.
  - An unknown, evicted, building or failed ref returns 404 or 409 with a fixed code, **never a silent fallback to the live graph**.
- **Hosted:** the same routes, under the project's auth. A layer is a retained derivation of the customer's code, so it is memory-only (§4).

## 7. Tests (slice one)

- A view at the live graph's own commit answers every sampled query the same as the live graph, apart from the runtime edges it hides.
- A runtime edge added to the live graph after a view was composed appears in the next request on that ref.
- A runtime edge added while a multi-step request is awaiting (the card route) does not appear in that request's answer. Every step reads the view it resolved at the start, and the next request sees the edge.
- A service declared at live and absent at the ref (sole declarer) is absent from the view, and its runtime edges count as hidden. A node also declared by another repository stays.
- A file removed at the ref hides its runtime edges, and the hidden count says so.
- Eviction order, the TTL and pins.
- Two concurrent builds for one key run one extraction.
- An unknown ref never falls back to live.
- No layer or view reaches a snapshot or any file.

## Not in this contract

- **The overlay (read-through) view.** It's ~0 to build but 1.5–2.6x slower to read *(one run)*, and it needs `NeatGraph` as an interface across every reader.
- **Incremental static layers** (re-extracting only changed files).
- **Re-anchoring hidden runtime edges** to their service.
- **The local working-tree label**, which ships separately.
- **Writes to views and FRONTIER staging on a view.**
- **Cross-ref queries, the MCP surface and persistence.**
