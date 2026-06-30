---
name: web-debugging
description: Web shell exposes connection state, daemon URL, last API calls and SSE events. No silent API failures. Read-only debug surface — observes, doesn't mutate.
governs:
  - "packages/web/app/components/StatusBar.tsx"
  - "packages/web/app/components/TopBar.tsx"
  - "packages/web/app/components/DebugPanel.tsx"
  - "packages/web/lib/proxy.ts"
adr: [ADR-058]
enforcement: [lint, review]
---

# Web shell debugging surface contract

The third of four web-shell contracts. Sibling contracts: [`web-completeness.md`](./web-completeness.md), [`web-multi-project.md`](./web-multi-project.md), [`web-bootstrap.md`](./web-bootstrap.md).

NEAT is a diagnostic tool. The web shell can't be the part that fails silently. When the daemon is down, when SSE is reconnecting, when a proxy returns 5xx — the user needs to see it without opening devtools.

## Binding rules

### 1. Daemon connection state is visible

StatusBar renders a small indicator (green / yellow / red dot) reflecting whether `GET /health` against `NEAT_API_URL` succeeded recently:

- **Green:** healthy, response < N seconds since last check
- **Yellow:** slow (response > N seconds) or retrying
- **Red:** failed for ≥ M consecutive attempts

Heartbeat default 5s. State exposed as `data-connection-state="ok|slow|down"` on the indicator element.

### 2. SSE connection state is visible

When the EventSource connection to `/events` is open, healthy, or reconnecting, the StatusBar (or another component) reflects it. EventSource auto-reconnects per spec; the UI tells the user that updates are flowing or paused, not just that nothing's happening.

State exposed as `data-sse-state="connected|reconnecting|disconnected"`.

### 3. No silent API errors

Every fetch that returns a non-2xx status surfaces a transient toast or banner with the error envelope from ADR-040 (`{ error, status, details? }`). User sees what failed, not just nothing. Errors don't crash the app — they're caught at the proxy layer and converted to user-visible signals.

### 4. Debug panel keyboard shortcut

`Ctrl+Shift+D` (or `Cmd+Shift+D` on macOS) toggles a debug panel overlay showing:

- Current `project` and `NEAT_API_URL`
- Last 10 API calls (path, status code, duration ms, timestamp)
- Last 10 SSE events (event type, timestamp, payload size)
- Daemon health-check history (last 20 heartbeats)

Panel exists as a separate component (`DebugPanel.tsx` or equivalent), reachable only via the shortcut (not in any visible menu — keeps it out of the user's way until needed).

### 5. Daemon URL is visible somewhere

TopBar or StatusBar renders the value of `NEAT_API_URL` (or its public-facing equivalent). Multi-daemon environments will eventually exist; the user always knows which backend they're querying.

For localhost: shows `localhost:8080`. For other targets: shows the hostname.

### 6. Read-only

The debugging surface observes; it does not mutate. No buttons in the debug panel that POST to the backend. No "force refresh" that bypasses the normal proxy. Per the existing role discipline (ADR-039 MCP read-only, ADR-050 CLI verbs read-only), debugging follows the same rule.

## Authority

- **Connection indicator + SSE state:** `packages/web/app/components/StatusBar.tsx`
- **Daemon URL display:** `packages/web/app/components/TopBar.tsx` or `StatusBar.tsx`
- **Error capture + toast emission:** `packages/web/lib/proxy.ts`
- **Debug panel overlay:** `packages/web/app/components/DebugPanel.tsx` (new component to add)

## Enforcement

`it.todo` block in `contracts.test.ts` for ADR-058:

- StatusBar.tsx renders an element with a `data-connection-state` attribute.
- StatusBar.tsx renders an element with a `data-sse-state` attribute.
- proxy.ts emits a toast / banner on non-2xx response (regex-check for the emission shape, or a runtime test if React Testing Library is available).
- A `DebugPanel.tsx` (or equivalent) component file exists in `packages/web/app/components/`.
- TopBar.tsx or StatusBar.tsx renders the daemon URL string.
- The debug panel doesn't include `<button onClick={...POST...}>` patterns — read-only enforcement.

### Environment indicator (ADR-073 §1)

Live assertions in `packages/web/test/environment-indicator.test.tsx` cover the `EnvironmentIndicator` exported from `StatusBar.tsx`:

- Green `"local"` chip when `window.location.hostname` is `localhost` (and the loopback IPv4/IPv6 equivalents).
- Orange `"remote · <hostname>"` chip for any non-loopback host.
- Adjacent info affordance carries the multi-instance explanation as its tooltip — so the operator running NEAT against a deployed daemon never confuses its graph with the local dev one.

### Login surface and bearer attachment (ADR-073 §3)

Live assertions in `packages/web/test/login-surface.test.tsx` cover the operator-facing auth surface:

- `/login` renders the single masked NEAT-token input, the deploy-platform caption, and the "Open dashboard" submit — the prior login-02 affordances (Email, Password, GitHub, Sign up, Forgot password) are gone.
- The logo animation mounts in the right pane and starts on the letter "N".
- `authedFetch` attaches `Authorization: Bearer <token>` when `localStorage['neat:authToken']` is set, and omits the header when it isn't — so the dashboard works against an unauthenticated dev daemon and a bearer-protected production daemon from the same bundle.

`StatusBar.tsx` also exports a `SignOutButton` that renders only when a token is in storage and clears it on click before bouncing the operator back to `/login`. The `useAuthGate` hook in `packages/web/lib/use-auth-gate.ts` is the route-level guard AppShell and IncidentsClient call from on mount; it short-circuits when `NEXT_PUBLIC_NEAT_AUTH_PROXY=true` so reverse-proxy deployments don't see the login surface.

## Out of scope

- **Telemetry / analytics.** Not collecting user actions, not phoning home. The debug panel is local-only.
- **Permission gating on the debug panel.** Localhost-only; no auth in MVP per ADR-058 #6 + cross-cutting "no auth in MVP".
- **Performance metrics dashboard.** Last 10 calls is intentional minimalism. Full metrics live in the future telemetry layer (out-of-scope for this contract).

Full rationale: [ADR-058](../decisions.md#adr-058--web-shell-debugging-surface).
