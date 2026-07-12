---
name: canvas-layout
description: "The live canvas runs deterministic ELK `layered` for structure and incremental in-place placement for the SSE live stream — pin existing positions, place only the new node near its neighbor, batch ~750ms, pulse-in, never auto-reflow. Layout re-runs only on load and on an explicit user re-tidy. The observed-overlay is one continuous completion story — incomplete → completing → complete — with two diagnostic modes (Mode A idle, Mode B didn't-engage with diagnosis + the one fix) and two parallel paths to completion (run your app, or connect a provider). Framed as fusion, not contrast."
governs:
  - "packages/web/app/components/GraphCanvas.tsx"
  - "packages/web/app/components/canvas/**"
  - "packages/web/app/components/ObservedOverlay.tsx"
  - "packages/web/lib/layout/**"
adr: [ADR-098, ADR-101, ADR-089, ADR-134]
enforcement: [review]
---

# Live canvas layout contract

The canvas is the spine's spatial view ([`web-shell.md`](./web-shell.md)). It runs over the file-first graph ([`file-awareness.md`](./file-awareness.md)) and renders services as collapsible compound containers per that contract's compound-container clause. This contract governs how the canvas lays out and how it stays calm while the live OBSERVED layer streams in.

The signature moment of the redo is the OBSERVED layer landing on top of the static EXTRACTED graph — reality fusing into the model. That motion only works if the static structure stays put under it.

## 1. Deterministic structure: ELK `layered`

Structural layout is ELK `layered` — a tiered, top-down dependency flow, deterministic so the same topology yields the same positions. It is **not** a force-directed / COSE layout.

ELK runs in exactly two cases:

- On initial load of the graph.
- On an explicit user **re-tidy** action.

It runs at no other time. Determinism is what makes re-tidy safe: the user asks for a clean pass and gets the same stable arrangement every time.

## 2. Incremental in-place placement for the live stream

The canvas **never auto-reflows** on SSE. When a `node-added` / `edge-added` event arrives:

- **Pin all existing positions.** Existing nodes do not move.
- **Place only the new node**, near its connecting neighbor's existing position. No global relayout.
- **Batch / debounce** SSE events into a **~750 ms** window, so a burst of OBSERVED edges lands as one update, not a per-event stutter.
- **Highlight, don't relayout.** The new edge / node **pulses in** *in place* — the live layer arriving, the layout unmoved.

Re-running ELK on every SSE event is forbidden: it reshuffles the whole graph and destroys the "reality arriving over the code" reading. Deterministic layout is for *structure*; incremental in-place placement is for the *live stream*.

## 3. The observed-overlay: one completion story, two modes

The observed-overlay is the canvas's first-class state for "the live layer isn't fully here yet." It is **one continuous story** — **incomplete → completing → complete** — framed as **fusion / completion**, not contrast. Previously-thin / uninstrumented regions light up and solidify as OBSERVED arrives; the picture becomes whole; the agent's eyes fill in. Copy is completion language, never "where code and runtime disagree."

It is a canvas state, not a nav page, and it reads the instrumentation / audit signal to branch into two diagnostic modes:

- **Mode A — healthy, idle.** Instrumentation is wired; no traffic yet. Neutral, expectant: *"Your code's mapped — run your app to complete the picture with what it actually does."*
- **Mode B — didn't engage.** The runtime layer couldn't engage — no entry point, an uninstrumented database, a leaf service with no outbound calls (#545/#546). Diagnosis + the one fix, surfacing the **same signal as the CLI** (#547) and `errors.ndjson`: *"No entry point — add a `start` script,"* *"sqlite3 isn't instrumented — run `neat extend`."* This is the GUI face of [`file-awareness.md`](./file-awareness.md) §4's loud audit — an uncaptured / un-engaged runtime surfaced honestly, with the fix in reach.

### 3a. Two parallel paths, not two more modes (ADR-134)

Alongside whichever mode is active, the overlay offers a **second, parallel path**: *"or connect a provider."* This is not a third mode — Mode A/B each keep their own diagnostic story, and the provider path sits beside it as an equal alternative, never a fallback shown only when Mode B fires. OTLP (run your app) and a connector (point at where the service already runs) are both real, honest routes to a complete picture; the overlay names both.

The provider path is honest by construction:

- **Exactly the shipped providers**, sourced from the same set `connectors/registry.ts` dispatches — never a provider without a working `neat connector add <provider>` behind it (`connector-config.md` §5).
- **Points at the real CLI** (`connector-config.md` §3), the same command a terminal-first user would run. No in-GUI credential form this cut, and no path that could drift from what the CLI actually does.
- **A command block**, the same visual pattern Mode A's `neat sync` and Mode B's `neat extend` already use — not a new UI language for the second path.

## 4. Mode B gets equal design weight

Until ecosystem coverage closes, Mode B is the **common** case, not the exception — the OBSERVED layer frequently does not light up on a fresh real app. Mode B is designed to the same standard as the signature pulse. It is not an error state and does not read as an afterthought: it is the moment a user would otherwise churn, turned into the most helpful screen — exactly why the section needs the same care.

## 5. Overlay escapability (binding)

The observed=0 / didn't-engage overlay must **never** be an inescapable full-canvas modal. It is help, not a wall — the user can always get to the canvas underneath. Required:

- **Persistent per-project dismissal.** Once dismissed for a project, it stays dismissed for that project (not re-shown on every mount).
- **An always-visible close.** A close affordance is on-screen the whole time the overlay is up.
- **Backdrop-click-to-dismiss.** Clicking outside the card dismisses it.
- **A capped card height.** The card never grows to fill the canvas; its height is bounded so the graph stays reachable around it.

(Reference implementation: commit `297e081`.) Encode these so the overlay cannot regress into a trap on a 0-OBSERVED project.

## 6. Mode resolution (binding)

Mode B (didn't engage) requires a **real audit signal** — the `/api/instrumentation` `engaged?: bool` reading. `resolveOverlayMode` falls back to **Mode A** (healthy-idle) when the signal is absent. Never fabricate a specific cause: show the generic *"run your app to complete the picture"* (Mode A) unless a real signal names the gap (no entry point / an uninstrumented library). A specific Mode B diagnosis is only shown when a real signal backs it.

## 7. Designed states throughout

Every canvas state is designed, none falls back to a dead or broken-looking screen:

- **Loading** — a skeleton, not a blank canvas.
- **Empty graph** — a designed empty state with the next action, not a void.
- **Daemon-down** — a clear connection state (consistent with web-debugging #28), not silence.
- **Disconnected nodes** — parked deliberately, never a clipped orphan row dumped at the edge.

## Relationship to file-awareness

Layout operates over the file-first graph. Services render as collapsible compound containers grouping their files via the existing `CONTAINS` hierarchy ([`file-awareness.md`](./file-awareness.md), compound-container clause); collapsed by default, the selected service auto-expands. Edges stay file-grained and service-coarse fallback edges (#536) render as the honest coarse fallback, never as file→file precision — this contract's layout never collapses or fabricates that grain.

## Authority

- **Canvas + layout orchestration:** `packages/web/app/components/GraphCanvas.tsx`, `packages/web/app/components/canvas/**`
- **Deterministic layout + incremental placement:** `packages/web/lib/layout/**`
- **Observed-overlay (two modes):** `packages/web/app/components/ObservedOverlay.tsx`

## Enforcement

`it.todo` block in `contracts.test.ts` for ADR-098:

- The canvas calls ELK `layered` only on initial load and on the re-tidy handler — no ELK call in the SSE event path (regex-check the SSE handler does not invoke the layout run).
- The SSE handler pins existing node positions and places only the new node; it does not clear / recompute all positions.
- SSE events are batched/debounced (assert a debounce window in the SSE handler).
- An `ObservedOverlay` (or equivalent) component renders both Mode A and Mode B, with Mode B carrying the diagnosis + fix copy sourced from the same signal as the CLI warning.
- The overlay is escapable: it carries an always-visible close, dismisses on backdrop click, persists its per-project dismissal, and caps its card height — it is never an inescapable full-canvas modal (§5).
- `resolveOverlayMode` selects Mode B only when a real audit signal (`/api/instrumentation` `engaged?`) is present, and falls back to Mode A when it is absent — no fabricated specific cause (§6).
- Designed loading / empty / daemon-down / disconnected states exist (no bare blank-canvas branch).
- The overlay's "connect a provider" path lists only providers `connectors/registry.ts` actually dispatches — no hardcoded provider name that isn't in the dispatch table (§3a).

Full rationale: [ADR-098](../decisions.md#adr-098--live-canvas-layout-deterministic-structure-incremental-live-placement); the overlay-escapability and Mode-resolution clauses are part of [ADR-101](../decisions.md#adr-101--one-gui-over-many-daemons-via-per-daemon-profiles-supersedes-adr-096-5); the two-parallel-paths clause (§3a) is [ADR-134](../decisions.md#adr-134--the-observed-overlay-leads-with-two-paths-run-your-app-or-connect-a-provider).
