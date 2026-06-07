---
name: web-multi-project
description: Web shell scopes every backend call to the user-selected project. AppShell owns project state. Project changes trigger data refresh. No hardcoded project names. The runtime corollary of ADR-026.
governs:
  - "packages/web/app/components/AppShell.tsx"
  - "packages/web/app/components/TopBar.tsx"
  - "packages/web/app/components/GraphCanvas.tsx"
  - "packages/web/app/components/Inspector.tsx"
  - "packages/web/app/components/StatusBar.tsx"
  - "packages/web/app/components/Rail.tsx"
  - "packages/web/app/page.tsx"
  - "packages/web/app/incidents/page.tsx"
  - "packages/web/app/incidents/IncidentsClient.tsx"
  - "packages/web/lib/proxy.ts"
  - "packages/web/lib/fixtures.ts"
  - "packages/web/app/api/**"
adr: [ADR-057, ADR-062, ADR-026, ADR-051]
---

# Web shell multi-project routing contract

The second of four web-shell contracts. Sibling contracts: [`web-completeness.md`](./web-completeness.md), [`web-debugging.md`](./web-debugging.md), [`web-bootstrap.md`](./web-bootstrap.md).

When NEAT runs against an unfamiliar codebase (medusa, the canonical MVP-success-PR target), the web shell must show *that codebase's* graph. The backend already supports multi-project routing per ADR-026; this contract makes the frontend honor it consistently.

Today's gap (per `audit/09-gaps-and-stubs.md`): *"Multi-project — graph not re-fetched on project change."*

## Binding rules

### 1. Single source of truth

`AppShell.tsx` owns the `project` state via `useState<string | null>` (null = unresolved, rule 2 amendment). Every component that fetches backend data accepts `project` as a prop or reads it from a context. No component manages its own project state. (`IncidentsClient` is its own page root and owns the equivalent state for `/incidents`, resolved through the same shared selector.)

### 2. Initial project resolution chain (amended 2026-06-07, #461 — the `'default'` fallback is gone)

In order, first non-empty wins:

1. URL query param: `?project=X`
2. `localStorage.getItem('neat:lastProject')` — survives reload
3. First **active** entry from `GET /projects` (rule 2.3 below)
4. Nothing. If steps 1–3 produce no value, `project` is `null` and stays `null`.

Steps 1-2 run synchronously inside the `useState` lazy initializer; step 3 is async and runs from a `useEffect` after mount only when steps 1-2 produced no value. AppShell is rendered client-only (see rule 2a below), so the synchronous reads are safe — no server-side execution to disagree with.

There is no project named `'default'` in any registry, so the old step-4 fallback bought nothing except a guaranteed 404 storm: every fresh session (no URL param, no localStorage) mounted the data-fetching consumers against `project=default` before step 3 could land, and each one threw a "project not found" toast at the first thing a new user sees (#461). Unresolved is now modeled honestly:

- `AppShell` owns `project` as `useState<string | null>`; `null` means "resolution has not produced a project yet" — either still in flight or genuinely nothing registered.
- **Every data-fetching consumer gates on it.** A component holding `project: string | null` fires no project-scoped request, opens no SSE stream, and starts no health/heartbeat interval while the value is `null`. The `useEffect(..., [project])` dependency re-runs the effect when resolution lands, so requests fire exactly once, with the real name.
- When resolution completes empty (no registered projects), the shell shows its no-project state (TopBar renders the switcher with "no registered projects"); it does not invent a name to ask the daemon about.
- `IncidentsClient` mirrors the same chain for cold deep-links to `/incidents`: URL → localStorage → `/projects` via the shared selector (`lib/resolve-project.ts`) → null, with the incidents fetch gated identically.

### 2.3 Step 3 is health-aware

The `/projects` payload carries a `status` per ADR-051 (`'active' | 'paused' | 'broken'`). Step 3 must not blindly take `list[0]` — a `broken` (dead path) or `paused` project resolves to an empty/erroring graph and blanks the dashboard (#419). Resolution within step 3:

1. First project whose `status` is `'active'`.
2. If none are active, the first project with a name (so a single non-active registered project still resolves).
3. If the list is empty (or the registry is unreachable), `null` — unresolved, per rule 2's amendment (#461).

The selector is a pure function (`resolveProjectFromList` in `lib/resolve-project.ts`, re-exported from `AppShell.tsx`; shared with `IncidentsClient`) so it can be unit-tested directly without rendering.

### 2a. Client-only render boundaries (ADR-062 + 2026-05-11 amendment, supersedes the SSR-safety amendment to ADR-057)

Two page entrypoints mount client-only via `next/dynamic` with `{ ssr: false }`:

- `packages/web/app/page.tsx` mounts AppShell client-only (ADR-062 §1).
- `packages/web/app/incidents/page.tsx` mounts `IncidentsClient` client-only (ADR-062 §4 amendment, 2026-05-11).

In both cases the Next.js server emits the static HTML shell (head, fonts, CSS link, empty `<body>` placeholder); the React subtree builds on the client.

Required shape:

```tsx
// packages/web/app/page.tsx
import dynamic from 'next/dynamic'
const AppShell = dynamic(() => import('./components/AppShell').then((m) => m.AppShell), {
  ssr: false,
})
```

```tsx
// packages/web/app/incidents/page.tsx
import dynamic from 'next/dynamic'
const IncidentsClient = dynamic(
  () => import('./IncidentsClient').then((m) => m.IncidentsClient),
  { ssr: false },
)
```

Consequences:

- Both subtrees may read `window.*` / `localStorage.*` / `document.*` / `navigator.*` synchronously during their render path. The lazy-initializer pattern for rule 2 is the contract surface, not a workaround.
- There is no server-side first render to keep byte-identical. The earlier ADR-057 "rule 2a — SSR-safe execution" amendment is superseded; its body is retained in `decisions.md` for historical context only.
- Layout, `/api/**` route handlers, and any future page that doesn't need synchronous browser-API reads keep server-side rendering. SSR-off is opt-in per route, named explicitly here.

Forbidden:

- Removing `{ ssr: false }` from either `dynamic(...)` call without a superseding ADR. The two costs the SSR-safe amendment imposed (the `'default'`-flash and the double-fetch on every `useEffect([project])` consumer) re-appear immediately if either subtree starts SSR-ing again.

### 3. Project change triggers data refresh

When `project` changes — switcher click, URL update, deep link — every component that depends on it re-fetches via `useEffect(..., [project])`. No stale data from the previous project carries over. GraphCanvas, Inspector, StatusBar, Incidents page — all of them.

### 4. URL stays in sync

Updating the project state writes the new value to the URL (`?project=X`) so the page can be shared / bookmarked / deep-linked. Reading the URL on load is the first step of the resolution chain (rule #2).

### 5. API proxy routes accept `project`

All routes under `packages/web/app/api/` accept `?project=X` as a query param (or path-scoped `/projects/:project/X` if the proxy uses that shape). The route forwards to the matching backend endpoint per ADR-026's dual-mount.

### 6. TopBar surfaces the active project

The user always knows which codebase NEAT is currently graphing — no ambiguity, no implicit defaults. TopBar renders the project name visibly. The switcher (uses `GET /projects` per ADR-051) is reachable via at most one click.

### 7. Project switcher is a real control

Not a stub. Clicking an entry calls `setProject(name)` and updates the URL. Per ADR-056 (web-completeness), no empty handler permitted.

### 8. No hardcoded project names in branching logic (amended 2026-06-07, #461)

No `'default'`, no `'medusa'`, no `'neat'`, no `if (project === 'demo')` anywhere in `packages/web/` client components. The previous carve-out — `'default'` as the explicit fallback in `AppShell.tsx`'s state initializer — is revoked; unresolved is `null`, not a made-up name (rule 2 amendment). Same rule as the cross-cutting "no demo-name hardcoding" (cross-cutting rule 8) but extended to the web track.

Allowed locations for project-name string literals:

- Test fixtures (`packages/web/lib/fixtures.ts` — though even there, "demo" is a fixture name, not a code branch)
- Comments and docstrings

## Authority

- **State owner:** `packages/web/app/components/AppShell.tsx`
- **Display + switcher:** `packages/web/app/components/TopBar.tsx`
- **Project-aware proxy:** `packages/web/lib/proxy.ts`
- **Project-aware API routes:** `packages/web/app/api/**/route.ts`

## Enforcement

`it.todo` block in `contracts.test.ts` for ADR-057:

- AppShell.tsx initializes project from URL → localStorage → /projects, `null` when nothing resolves (regex-check the source for the resolution chain).
- Every component file that imports `proxy.ts` or fetches from `/api/` accepts `project: string | null` as a prop and fires no project-scoped request while it is `null` (#461).
- Every API proxy route under `packages/web/app/api/` forwards `project` query/path to the backend.
- No hardcoded project names (`medusa`, `neat`, `demo`, etc.) in branching logic under `packages/web/app/components/` or `packages/web/lib/` (excluding fixtures.ts).
- Multi-project re-fetch test: render AppShell with `project=A`, change to `B`, assert all data-fetching hooks re-ran. Requires Vitest + React Testing Library — new tooling for the web track. Flag in PR.
- **Client-only boundaries: both `app/page.tsx` and `app/incidents/page.tsx` import `dynamic` from `next/dynamic` and mount their respective subtree with `{ ssr: false }` (ADR-062 + 2026-05-11 amendment).**

Full rationale: [ADR-057](../decisions.md#adr-057--web-shell-multi-project-routing), [ADR-062](../decisions.md#adr-062--web-shell-renders-client-only-ssr-disabled-at-the-appshell-boundary).
