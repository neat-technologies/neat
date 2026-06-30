---
name: web-multi-project
description: Web shell scopes every backend call to the user-selected project. AppShell owns the profile state (per-daemon, ADR-101). The resolution chain is URL → localStorage → daemon discovery → null. Profile changes trigger data refresh. No hardcoded project names. The runtime corollary of ADR-026, re-keyed to per-daemon profiles under ADR-101.
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
adr: [ADR-057, ADR-062, ADR-026, ADR-051, ADR-101]
enforcement: [lint, review]
---

# Web shell multi-project routing contract

The second of four web-shell contracts. Sibling contracts: [`web-completeness.md`](./web-completeness.md), [`web-debugging.md`](./web-debugging.md), [`web-bootstrap.md`](./web-bootstrap.md).

When NEAT runs against an unfamiliar codebase (medusa, the canonical MVP-success-PR target), the web shell must show *that codebase's* graph. The backend already supports multi-project routing per ADR-026; this contract makes the frontend honor it consistently.

Today's gap (per `audit/09-gaps-and-stubs.md`): *"Multi-project — graph not re-fetched on project change."*

## Binding rules

### 1. Single source of truth

`AppShell.tsx` owns the active **profile** state via `useState<…| null>` (null = unresolved, rule 2 amendment). Under ADR-101 the selection is a per-daemon profile (`{ endpoint, authToken? }`), and the project *name* is the profile's label — the state the shell threads is the resolved profile, not a bare project string. Every component that fetches backend data accepts the resolved profile (or its endpoint) as a prop or reads it from a context. No component manages its own project/profile state. (`IncidentsClient` is its own page root and owns the equivalent state for `/incidents`, resolved through the same shared selector.)

### 2. Initial profile resolution chain (amended under ADR-101 — step 3 is daemon discovery; amended 2026-06-07, #461 — the `'default'` fallback is gone)

In order, first non-empty wins:

1. URL query param: `?project=X`
2. `localStorage.getItem('neat:lastProject')` — survives reload
3. **Daemon discovery** — the discovered, reachable profile (rule 2.3 below). Under ADR-101 this replaces the old `GET /projects` step: profiles come from `~/.neat/daemons/*.json` (local) / the platform list (hosted), each serving its project at the daemon root.
4. Nothing. If steps 1–3 produce no value, the resolved profile is `null` and stays `null`.

This is a real amendment, not just a web-shell change: rule 2's old assertion was that step 3 reads the `GET /projects` list, and that is the `contracts.test.ts` expectation #549 flips when the GUI moves to per-daemon discovery. The contract moves with the implementation. The web-shell IA (#44, §3) describes the switcher face of the same model; ADR-101 is the rationale.

Steps 1-2 run synchronously inside the `useState` lazy initializer; step 3 is async and runs from a `useEffect` after mount only when steps 1-2 produced no value. AppShell is rendered client-only (see rule 2a below), so the synchronous reads are safe — no server-side execution to disagree with.

There is no project named `'default'` in any registry, so the old step-4 fallback bought nothing except a guaranteed 404 storm: every fresh session (no URL param, no localStorage) mounted the data-fetching consumers against `project=default` before step 3 could land, and each one threw a "project not found" toast at the first thing a new user sees (#461). Unresolved is now modeled honestly:

- `AppShell` owns `project` as `useState<string | null>`; `null` means "resolution has not produced a project yet" — either still in flight or genuinely nothing registered.
- **Every data-fetching consumer gates on it.** A component holding `project: string | null` fires no project-scoped request, opens no SSE stream, and starts no health/heartbeat interval while the value is `null`. The `useEffect(..., [project])` dependency re-runs the effect when resolution lands, so requests fire exactly once, with the real name.
- When resolution completes empty (no registered projects), the shell shows its no-project state (TopBar renders the switcher with "no registered projects"); it does not invent a name to ask the daemon about.
- `IncidentsClient` mirrors the same chain for cold deep-links to `/incidents`: URL → localStorage → daemon discovery via the shared selector (`resolveProfile` in `lib/resolve-project.ts`) → null, with the incidents fetch gated identically.

### 2.3 Step 3 is liveness- and reachability-aware (ADR-101)

Under ADR-101 step 3 enumerates per-daemon profiles, not the `GET /projects` list. Each discovered daemon record (`daemon.json`) carries a `running | stopped` **liveness** state — not ADR-051's `active | paused | broken` registry vocabulary, which lived on the dropped `projects.json` and is not surfaced by the GUI in v1. Step 3 must not blindly take the first profile — a `stopped` or unreachable daemon resolves to an empty/erroring graph and blanks the dashboard (#419). Resolution within step 3:

1. First profile whose daemon is `running` **and reachable**. The discovery file is a *hint*: `resolveProfile` confirms reachability with a cheap health probe on the profile `endpoint` before auto-selecting, so a stale `status:"running"` record never cold-opens onto a dead endpoint (#419 in new clothes).
2. If none are reachable, no auto-select — a `stopped` / unreachable profile is shown in the switcher but never auto-selected.
3. If discovery finds no profiles (or none reachable), `null` — unresolved, per rule 2's amendment (#461).

The selector is a pure function (`resolveProfile` in `lib/resolve-project.ts`, re-exported from `AppShell.tsx`; shared with `IncidentsClient`) so it can be unit-tested directly without rendering. The switcher face of this clause is web-shell (#44) §3.

### 2.4 URL / localStorage keys keep their shape (ADR-101)

`?project=<name>` and `neat:lastProject` remain **names** (the profile's label). They resolve to the discovered profile whose `project` matches **and is reachable**; a stored name with no matching reachable daemon resolves to **null**, not an error. The URL/localStorage key shape does not change shape under ADR-101 — only what they resolve *to* (a profile, not a `/projects` entry).

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

### 5. API proxy routes target the selected profile's daemon root (ADR-101)

All routes under `packages/web/app/api/` resolve the active profile and forward to that profile's `endpoint` at the daemon **root**. Under ADR-101 the `/projects/:name` prefix and ADR-026's dual-mount are dropped — a daemon serves its one project at the root (`GET /graph`), so the proxy carries no path prefix; the `?project=<name>` label only selects *which* profile (and thus which endpoint), it is not a backend path segment. The `/api/projects` enumerator becomes a daemon-discovery enumerator (`/api/profiles`).

### 6. TopBar surfaces the active project

The user always knows which codebase NEAT is currently graphing — no ambiguity, no implicit defaults. TopBar renders the active profile's project name visibly. The switcher (lists profiles from daemon discovery per ADR-101, no longer `GET /projects`) is reachable via at most one click.

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

- AppShell.tsx initializes the active profile from URL → localStorage → daemon discovery (`resolveProfile`), `null` when nothing resolves (regex-check the source for the resolution chain); a stale `running` / unreachable profile is never auto-selected (#419).
- Every component file that imports `proxy.ts` or fetches from `/api/` accepts the resolved profile (nullable) as a prop and fires no profile-scoped request while it is `null` (#461).
- Every API proxy route under `packages/web/app/api/` targets the selected profile's `endpoint` at the daemon root — no `/projects/:name` path prefix (ADR-101).
- No hardcoded project names (`medusa`, `neat`, `demo`, etc.) in branching logic under `packages/web/app/components/` or `packages/web/lib/` (excluding fixtures.ts).
- Multi-project re-fetch test: render AppShell with `project=A`, change to `B`, assert all data-fetching hooks re-ran. Requires Vitest + React Testing Library — new tooling for the web track. Flag in PR.
- **Client-only boundaries: both `app/page.tsx` and `app/incidents/page.tsx` import `dynamic` from `next/dynamic` and mount their respective subtree with `{ ssr: false }` (ADR-062 + 2026-05-11 amendment).**

Full rationale: [ADR-057](../decisions.md#adr-057--web-shell-multi-project-routing), [ADR-062](../decisions.md#adr-062--web-shell-renders-client-only-ssr-disabled-at-the-appshell-boundary), [ADR-101](../decisions.md#adr-101--one-gui-over-many-daemons-via-per-daemon-profiles-supersedes-adr-096-5).
