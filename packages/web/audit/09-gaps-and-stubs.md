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
| Policies | wired | Violation view (live) + enforcement preview. |
| Divergences | disabled | Sibling page, progressive; rendered disabled with "soon" affordance. |
| Incidents | disabled | Sibling page, progressive; rendered disabled with "soon" affordance. |
| Logs | wired | Native OTel + connector logs, one feed; source filter chips (docs/contracts/logs.md, ADR-132). |
| Find | disabled | ⌘K palette is the Find surface today; a full page is progressive. |
| Settings | disabled | Sibling page, progressive; rendered disabled with "soon" affordance. |

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

### Metrics — fully synthetic

The three Inspector metrics (req/s, p99, err%) still come from `Math.random()`,
re-randomised per node. No real metrics API yet. Deferred — surfaces as numbers
that don't change while you stare at one node.

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
| Metrics | Random values re-announced on every render — known issue, deferred until real metrics. |

---

## Minor visual inconsistencies

| Item | Note |
|------|------|
| `--n-stream` and `--n-queue` | Same hex (`#b8b0c8`) — may be intentional but duplicated. |
| `cloud` compound type | Uses hardcoded `#1d1d22` instead of a CSS token. |
| Incidents topbar | Inline `style` on the Link element instead of a CSS class. |
