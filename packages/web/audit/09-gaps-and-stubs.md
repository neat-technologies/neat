# Gaps and Stubs

Inventory of stub UI, deferred features, and known gaps in the web shell.
Per ADR-056 §4 this file is the canonical inventory the contract test reads.
Each entry is in one of three states:

- **wired** — handler implemented; element produces an observable change
- **disabled** — element renders with `disabled` + affordance (lower opacity, "coming in v0.3.x" tooltip)
- **deferred** — feature not yet rendered at all (no UI surface to wire/disable)

When code state changes, this file changes in lockstep.

---

## Stub buttons — current state

> The GUI-redo (branch `gui-redo-core`) replaced the icon Rail with a labeled
> page-nav sidebar (`PageSidebar`, jedorini sidebar) and rewrote the TopBar
> (project switcher + ⌘K palette opener + account) and the canvas toolbar
> (re-tidy / fit / center on the ELK layout). The old TopBar History/Share/
> Layout/Lock buttons and the `Layout: cose` / `Locked` canvas toggles are gone;
> sidebar page items that aren't built this redo render disabled-with-affordance
> (web-completeness #26). The `Rail.tsx` file is retained but no longer mounted
> (superseded by `PageSidebar`); its disabled buttons stay documented below so
> the file remains contract-consistent until it's deleted in a follow-up.

### TopBar

| Button | Status | Notes |
|--------|--------|-------|
| account | disabled | Hosted auth lands with the SaaS dashboard; disabled with affordance. |

### GraphCanvas toolbar

| Button | Status | Notes |
|--------|--------|-------|
| re-tidy | wired | Re-runs the deterministic ELK layered layout — the only place the graph reflows. |
| fit | wired | `cy.fit(...)`. |
| center | wired | `cy.center()`. |

### PageSidebar (labeled page nav)

| Button | Status | Notes |
|--------|--------|-------|
| Graph | wired | The fused-graph spatial view — primary page. |
| Policies | wired | Rule list (live) + violation view (live) + enforcement preview. |
| Divergences | wired | In-shell peer-query page over `/api/divergences`; a row focuses the pair on the graph. |
| Incidents | wired | Routes to `/incidents`; the OTel error-events table. |
| Find | wired | In-shell semantic-search page over `/api/search`; the ⌘K palette runs the same search inline. |
| Settings | disabled | Sibling page, progressive; routes through to StubPage's "not built yet" copy. |

### Policies page (enforcement preview)

| Button | Status | Notes |
|--------|--------|-------|
| Gate mutations | disabled | Enforcement kernel (ADR-093/094/095) unshipped — preview, disabled-with-intent. |
| Would-violate simulation | disabled | Preview, disabled-with-intent. |
| Approve / reject | disabled | Preview, disabled-with-intent. |
| Block on promotion | disabled | Dead in prod (#533); preview, disabled-with-intent. |

### Rail (retained, no longer mounted — superseded by PageSidebar)

| Button | Status | Notes |
|--------|--------|-------|
| Graph (G) | wired | Active route — primary view. |
| Layers (L) | disabled | Tooltip: "Layers — coming in v0.3.x". |
| Find (F) | wired | Focuses TopBar search input. |
| NeatScript (N) | disabled | Tooltip: "NeatScript — coming in v0.3.x". |
| Time travel (T) | disabled | Tooltip: "Time travel — coming in v0.3.x". |
| Blast radius (B) | disabled | Tooltip: "Blast radius — coming in v0.3.x". (Counter badge stays live.) |
| Diff (D) | disabled | Tooltip: "Diff — coming in v0.3.x". |
| Comments (C) | disabled | Tooltip: "Comments — coming in v0.3.x". |
| Incidents | wired | Routes to `/incidents`; badge from `/api/incidents`. |
| Agents (A) | disabled | Tooltip: "Agents — coming in v0.3.x". |

### Inspector

| Tab | Status | Notes |
|-----|--------|-------|
| Inspect | wired | Default tab — node detail. For a FileNode: path, calls originating from it (provenance + `file:line` evidence), owning service. For a service: the files it CONTAINS. |
| Edges | wired | All in/out edges with provenance. |
| Owners | wired | Renders `ServiceNode.owner` per ADR-054, or "no owner declared" hint. |
| History | disabled | Tooltip: "History — coming in v0.3.x". |

### Inspector node-scoped queries (web-shell §6 — actions, not pages)

Blast-radius and dependencies are node-scoped inspector actions that focus the
canvas, per web-shell §6 — never nav pages.

| Button | Status | Notes |
|--------|--------|-------|
| Blast radius | wired | Inspector Impact section — fetches `/api/graph/blast-radius/:id`, lists what depends on the node transitively; each row selects that node. |
| Dependencies | wired | Inspector Impact section — fetches `/api/graph/dependencies/:id`, lists what the node depends on transitively; each row selects that node. |
| highlight on graph | wired | Dims all but the traced set and fits the canvas to it (the BFS-highlight, web-shell §6). |

### GraphCanvas drill-down (file-awareness §2/§3)

File-first canvas: services are grouping namespaces only, not visual entities.
Drill affordances operate on file nodes and their Inspector panel. The
first-column label below is a verbatim source string so the ADR-056 #4 scan resolves it.

| Element | Status | Notes |
|---------|--------|-------|
| owning service | wired | Inspector, FileNode view — opens the file's service and selects it. |
| file-list | wired | Inspector, service view — each file row drills the canvas open and selects the file. |
| target clickable | wired | Inspector, "calls from this file" — selects the called node. |

---

## Feature gaps (not stubs — not yet rendered)

### Search — no result navigation

Clicking a search result selects the node via `onNodeSelect` but does not currently
pan/zoom the canvas. The selection useEffect in `GraphCanvas.tsx` does pan to the
node when `selectedNodeId` changes, so this is largely covered today.

### Incidents — back-link to graph node

`Link` in the incidents row points to `/?node=<id>&project=<X>`, and AppShell
reads the `?node=` param on mount and pre-selects it. Wired.

### Incidents — badge count on rail

Rail fetches `/api/incidents?limit=1&project=X` and renders the count. Wired.

### StatusBar scrubber — not interactive

The time scrubber (`.scrub`) is decorative. Time-travel is deferred (`Rail: Time travel`
is in the disabled list above). Replacing the decoration with a real seek control
is a v0.3.x concern.

### SSE live updates — toast/pulse feedback

ADR-058 #3 routed non-2xx fetch errors through the toast surface. SSE successes
(node-added / edge-added) are recorded into the debug-panel event log without
user-visible toasts — keeps the surface quiet on healthy days. This is by design.

### Multi-project — project change re-fetches

Resolved in ADR-057 (this batch): GraphCanvas, Inspector, StatusBar, Rail, and
the Incidents page all re-fetch on `project` change.

### Metrics — derived from OBSERVED signal, p99 still honest-dash

Inspector's `spans` and `err %` aggregate the OBSERVED-provenance edges on the
selected node (`spanCount` / `errorCount` off the edge signal, #357) and render
`—` when no OBSERVED edge exists yet — real numbers, not placeholders. `p99 ms`
has no signal to derive from yet and renders `—` rather than a synthetic
stand-in. The `claude-design/` prototype — a separate, unmounted surface, not
part of the Next.js app router — still generates all three metrics via
`Math.random()`; the mounted Inspector is the one that ships to users.

---

## Keyboard shortcuts

The Rail tooltips advertise letter shortcuts. Only `F` (Find) and the global
`Ctrl/Cmd+Shift+D` (debug panel toggle, ADR-058) and `⌘K` (focus search) are
wired today. Wiring `G/L/N/T/B/D/C/A` is a v0.3.x concern; the tooltip hints
remain because they document the future surface.

---

## Accessibility gaps

| Element | Issue |
|---------|-------|
| Rail buttons | `aria-label` set on every button. Tooltip via title. |
| Inspector tabs | `role="tab"` / `aria-selected` set; `aria-disabled` on deferred tabs. |
| Canvas | `#cy` has `aria-label="Service dependency graph"` and `role="img"`. |
| Search input | `aria-label`, `aria-expanded` set. |
| Search dropdown | `role="listbox"` / `role="option"` set. |
| Metrics | Mounted Inspector renders stable, OBSERVED-derived values (or `—`) — no re-randomising. `claude-design/`'s prototype still re-randomises per render if it's ever mounted. |

---

## Minor visual inconsistencies

| Item | Note |
|------|------|
| `--n-stream` and `--n-queue` | Same hex (`#b8b0c8`) — may be intentional but duplicated. |
| `cloud` compound type | Uses hardcoded `#1d1d22` instead of a CSS token. |
| Incidents topbar | Inline `style` on the Link element instead of a CSS class. |
