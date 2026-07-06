---
name: web-shell
description: "The web shell is a multi-page SaaS product whose spine is the fused graph — code and observed runtime in one file-grained model, read as full-stack context for an agent. A left page-nav sidebar carries the pages; a topbar carries the project switcher, the ⌘K command palette, and env/account. The canvas is one page among list/table views. Divergence is a peer query, not the marquee; blast-radius / dependencies / root-cause are node-scoped actions, not pages. The Policies violation view wires live; everything that acts renders as explicit preview."
governs:
  - "packages/web/app/components/AppShell.tsx"
  - "packages/web/app/components/Sidebar.tsx"
  - "packages/web/app/components/TopBar.tsx"
  - "packages/web/app/components/CommandPalette.tsx"
  - "packages/web/app/components/Inspector.tsx"
  - "packages/web/app/page.tsx"
  - "packages/web/app/divergences/**"
  - "packages/web/app/incidents/**"
  - "packages/web/app/policies/**"
  - "packages/web/app/settings/**"
  - "packages/web/app/logs/**"
adr: [ADR-097, ADR-101, ADR-056, ADR-057, ADR-062, ADR-132]
enforcement: [lint, review]
---

# Web shell IA contract

This is the IA contract for the GUI redo. It sits alongside the original four web-shell contracts ([`web-completeness.md`](./web-completeness.md), [`web-multi-project.md`](./web-multi-project.md), [`web-debugging.md`](./web-debugging.md), [`web-bootstrap.md`](./web-bootstrap.md)) and inherits all four. Where this contract names a page or surface, web-completeness (#26) governs it — no permanent stub UI; every interactive element is wired or explicitly disabled.

NEAT is a SaaS product whose spine is the fused graph: code and observed runtime in one file-grained model, the thing an agent reads as accurate full-stack context. The shell exists to make that model the product. The canvas is one view of it — the spatial view — among list and table views that ask the same model different questions.

## 1. The spine is the fused graph

The headline, the onboarding story, and the primary nav weight are the fused graph — *what your system is and does, unified.* The value is the model being true and complete, not the delta between declared and observed. Divergence is one query that falls out of the fused model; it is not what the product is. The IA never reads "divergence detector," and no surface frames NEAT as one.

## 2. Multi-page shell

The shell is three regions of chrome around a page:

- **Left page-nav sidebar** (jedorini `sidebar`) — the page set (§4). The graph carries the primary nav weight.
- **Topbar** — the project switcher (§3), the ⌘K command palette (§5), and env/account.
- **Status bar** — daemon + SSE connection state, per web-debugging (#28). Unchanged by this contract.

The canvas is one page among list/table views, not the only view. List/table pages (Divergences, Incidents, Policies, Logs) are how the user reads the same model without the spatial layer.

## 3. Project switcher is a per-daemon profile switcher (ADR-101)

The topbar carries the project switcher. One GUI drives many daemons through a single seam: the switcher lists **profiles** (ADR-101), one per discovered daemon. A profile is `{ endpoint, authToken? }` — the same shape local and hosted — and the GUI's API base is the *selected profile's* `endpoint`, served at the daemon **root**. There is no `/projects/:name` prefix and no `~/.neat/projects.json` dependency; per ADR-096 a daemon serves its one project at the root (`GET /graph`), so the project *is* the daemon and its name is the profile's label.

- **Profile source is discovery, not a registry.** Locally the switcher enumerates `~/.neat/daemons/*.json` → one profile per daemon (`{ endpoint: http://localhost:<ports.rest>, project }`); hosted, the platform's project list supplies each profile's `endpoint` + bearer `authToken`. Same shell, same code path — the profile source is the only local↔hosted swap point.
- **ADR-096 per-project daemons only.** The GUI does not speak the legacy `/projects/:name` multi-mount. If only a legacy daemon is running, discovery finds no profiles and the shell shows its empty state — there is no compatibility path.
- `AppShell` owns the **profile** state (was project state); resolution gates the same way `null` does in web-multi-project (#27) — every data-fetching consumer fires no request until a profile resolves. **No `default` fallback** — removed (#461), not reintroduced.
- The switcher is a real control (no empty handler, per #26): selecting a profile sets it as active and writes the profile's `?project=<name>` label to the URL.

**Status is liveness, not registry health.** Status-awareness derives from the daemon record's `running | stopped` liveness (`daemon.json`), not the dropped `projects.json` health vocabulary. The discovery enumerator lists `stopped` daemons but never auto-selects one; the no-`default` (#461) and don't-open-onto-a-dead-one (#419) intents carry over, now sourced from liveness. ADR-051's `active|paused|broken` semantics are **not surfaced by the GUI in v1** (stated, not silently dropped) — if reinstated later, name the source then.

**Reachability over the file.** `resolveProfile` treats `~/.neat/daemons/*.json` as a discovery **hint** and confirms **reachability** (a cheap health probe on the profile `endpoint`) before auto-selecting. A stale `status:"running"` record must never cause a cold-open onto a dead endpoint (#419 in new clothes). An unreachable profile is shown as such, not auto-selected.

The switcher is client-side aggregation over independent per-daemon endpoints; no shared coordination registry is reintroduced (ADR-096's core holds). The detailed resolution chain — URL → localStorage → daemon discovery → null — lives in web-multi-project (#27, amended under ADR-101).

## 4. The page set

Each sidebar page maps to a shipped capability. No page promises a feature that is not there (#26).

- **Graph** — the spatial canvas (governed by [`canvas-layout.md`](./canvas-layout.md) and [`file-awareness.md`](./file-awareness.md)). The spine.
- **Divergences** — a list/table over `get_divergences`, a peer query view (§6). A row focuses that pair on the graph.
- **Incidents** — the OTel error-events table that exists today. A thin surface earns a top-level slot only if it carries enough real data to justify one; otherwise it folds into a graph filter/panel rather than shipping half-empty (#26).
- **Policies** — the rule list plus the violation view live and the enforcement layer as preview (§7).
- **Find** — the ⌘K command palette (§5) plus `semantic_search`.
- **Settings / Project** — the project switcher surface, daemon/connection state, token.

STALE is a legend entry and an edge style, not a live decay surface — no edges animate going stale (auto-decay is not wired into the daemon). There is no one-click deploy/sync hero; those stay CLI-level.

## 5. ⌘K command palette

The topbar exposes a ⌘K command palette for jump-to-node / jump-to-file / jump-to-page and `semantic_search`. It is a real control per #26 — every entry it lists either navigates, selects, or is explicitly disabled with affordance.

## 6. Divergence is a peer query; node-scoped queries are actions, not pages

Divergence joins root-cause, blast-radius, and dependencies as an "ask the graph" view — valuable, not the headline.

**Blast-radius, dependencies, and root-cause are node-scoped actions, not nav pages.** The user selects a node; the inspector offers them; they focus the canvas with a BFS highlight; they do not navigate to a dedicated page. The marketing "sandboxed-feature blast radius" framing is unshipped and is not a GUI surface.

The persistent right inspector is empty/hinting when nothing is selected — not a blank slab — and fills with the selected node's provenance, verb, and confidence on selection (provenance lives in the inspector, not on the edges).

## 7. Policies: violation view live, enforcement layer preview

The GUI is the shipped product governed by web-completeness #26 — unlike the marketing site, it cannot imply a capability it does not have. The policy enforcement kernel is unshipped (ADR-093, ADR-094, ADR-095; audit do-not-say #2; #533). So the Policies page splits along the live/preview line explicitly:

**LIVE (real, read-only):**

- The violation **view** — `check_policies` / `evaluateAllPolicies` surfacing "these rules currently flag these nodes/edges." Shipped, tested, honest.

**PREVIEW (designed, explicitly disabled-with-intent per #26's "wired or explicitly disabled" clause, flips on when the kernel ships):**

- The gate, block, and approve/reject surfaces.
- The would-violate-on-change simulation.
- Block-on-FrontierNode-promotion. This one is dead in production and must not wire itself live inside the real-today list: the gate at `ingest.ts:1278` only fires when policy opts are passed (`if (opts.policies && opts.policyCtx)`), but both production callers of `promoteFrontierNodes` pass the graph only — `watch.ts:185` and `extract/index.ts:109`. The only caller that reaches the gate is a test. Wiring it live would render a control that does nothing — the exact #26 violation the preview discipline exists to avoid.

The preview→live flip is a future **`policy-actions` contract change** (`block` graduating from "schema exists / gate dead" to "enforced") gated on the governance kernel landing (ADR-093/094/095). The flip is an ADR, never a silent enable. This is build-ahead UI done #26-clean: designed now, honestly labeled, switching when the kernel ships.

## 8. Ship order

The runtime-led core — the canvas, the two-mode observed-overlay ([`canvas-layout.md`](./canvas-layout.md) §3), and the live pulse — is the thing that has to be great on day one. Sibling list pages (Divergences, Incidents, Policies, Logs, Find, Settings) land thinner and iterate. The shell ships on the core without waiting on the full page set; every surface it does ship is wired or explicitly disabled (#26).

## Authority

- **Shell + state owner:** `packages/web/app/components/AppShell.tsx`
- **Page nav:** `packages/web/app/components/Sidebar.tsx`
- **Project switcher + ⌘K + env/account:** `packages/web/app/components/TopBar.tsx`, `packages/web/app/components/CommandPalette.tsx`
- **Node-scoped query actions + provenance:** `packages/web/app/components/Inspector.tsx`
- **Pages:** `packages/web/app/{page,divergences,incidents,policies,settings}/**`

## Enforcement

`it.todo` block in `contracts.test.ts` for ADR-097, layered on the existing web-shell checks:

- The sidebar renders the page set; every entry routes to a shipped page or is explicitly disabled with affordance (no empty handler, #26).
- No nav page named or routed for blast-radius, dependencies, or root-cause — they are inspector actions that focus the canvas.
- AppShell resolves the active **profile** via URL → localStorage → daemon discovery → `null`, with no `default` literal (inherits #27 as amended under ADR-101); the switcher lists profiles discovered from `~/.neat/daemons/*.json` (local) / the platform list (hosted) and targets each profile's `endpoint` at the daemon root (no `/projects/:name`); `stopped` / unreachable profiles are shown but never auto-selected (#419).
- The Policies page wires the violation view to `check_policies` / `evaluateAllPolicies`, and renders the gate / block / approve-reject / would-violate / block-on-promotion surfaces as `disabled` / `preview` (regex-check for the preview affordance on the acting controls; assert none carry a live POST handler).
- No surface labels NEAT a "divergence detector"; the graph carries the primary nav weight.

Full rationale: [ADR-097](../decisions.md#adr-097--web-shell-ia-the-fused-graph-as-the-spine-of-a-multi-page-saas-shell).
