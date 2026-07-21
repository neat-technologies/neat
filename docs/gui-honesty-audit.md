# GUI honesty audit (#804)

Every user-reachable surface in `packages/web/app`, classified **REAL** (renders live daemon data), **STUB** (placeholder/hardcoded), or **DEAD** (unreachable). Checked against the live Brief daemon (237 nodes, 1604 incidents) on 2026-07-20, not just fixtures — fixtures are exactly what masked the bugs #809 caught.

## Nav pages

Every entry in `lib/nav.ts` is `kind: 'page'` — there are **no `todo` pages**, so nothing should ever render StubPage's "not built yet".

| Surface | Verdict | Evidence |
|---|---|---|
| Graph | REAL | AppShell branch → `/api/graph` → daemon `/graph` (237 nodes live) |
| Divergences | REAL | AppShell branch → `/api/divergences` |
| Policies | REAL | AppShell branch → `/api/policies` |
| Incidents | REAL | standalone `/incidents` route → `/api/incidents` → daemon `/incidents` (1604 live). **Was reachable as StubPage via ⌘K — fixed here.** |
| Connectors | REAL | AppShell branch → `ConnectorsPage` → `/api/connectors` (ADR-136) |
| Logs | REAL | AppShell branch → `/api/logs` |
| Find | REAL | AppShell branch → `/api/search` (shape fixed in #811) |
| Settings | REAL | AppShell branch → `SettingsPage` (ADR-135) |

## Components / overlays

| Surface | Verdict | Evidence |
|---|---|---|
| Inspector → root cause | REAL | `/api/graph/root-cause/:id`, reads `rootCauseReason` (#811); verified live returns a real reason |
| Inspector → blast radius / deps | REAL | `/api/graph/blast-radius`, `/api/graph/dependencies` |
| ObservedOverlay / GraphCanvas → instrumentation | HONEST-DEGRADED | daemon has no `/instrumentation` endpoint yet (404); `/api/instrumentation` returns `{ engaged: null }` neutrally, never fabricates a diagnosis. A richer overlay needs a core endpoint — follow-up, not a lie. |
| Rail.tsx | REAL | imported by LogsPage, GraphCanvas, ObservedOverlay (the audit's "dead Rail.tsx" hunch was wrong) |

## Dead / orphan

| Surface | Verdict | Action |
|---|---|---|
| `/api/stale-events` | REMOVED | no consumer in `app/`; the orphan proxy was removed in the #824 follow-up |
| `StubPage` | DORMANT | no live caller after this fix; kept intentionally as the mechanism for the next `todo` page (ADR-135) |

## The one live lie, and the fix

`lib/nav.ts` marks Incidents as a standalone route (`/incidents`). The **sidebar** honored that (`router.push`), but the **CommandPalette** sent every page through `onNavigate`, so selecting Incidents from ⌘K hit a nonexistent AppShell branch and rendered StubPage's "not built yet" — a shipped page (1604 real incidents behind it) looking unbuilt. The two nav surfaces disagreed.

Fix: the standalone-route map moved to `lib/nav.ts` as the single source of truth (`NAV_ROUTES`); both the sidebar and the palette read it. Guarded by tests in `nav-reachability.test.tsx` so the two surfaces can't drift again.
