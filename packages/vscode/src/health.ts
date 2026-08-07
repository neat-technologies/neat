// Daemon health for the status-bar item.
//
// One lightweight GET to the local NEAT daemon's `/health`. That endpoint is
// always unauthenticated (it's in the daemon's default probe allow-list, see
// `packages/core/src/auth.ts`) and already carries per-project `nodeCount`, so a
// single call answers both "is the daemon up?" and "how big is the graph?" — no
// need to fetch the full `/graph` payload just to count nodes.
//
// The daemon-wide `/health` shape (see `packages/core/src/api.ts`):
//   { ok: true, uptimeMs, project?, projects: [{ name, nodeCount, edgeCount }] }
// A per-project daemon also carries `project` at the top level; either way the
// node total is the sum over `projects[]`. A legacy single-project `/health`
// carries `nodeCount` at the top level, which we fall back to.
//
// The network call is injectable so the poll path unit-tests with a fake fetch —
// no live daemon, no real editor.

import { DEFAULT_DAEMON_URL } from './mcp-config'

export interface HealthSnapshot {
  ok: boolean
  nodeCount: number
}

// Parse a `/health` body into liveness + a node total. Defensive: any shape that
// isn't a clearly-ok payload reads as down with zero nodes, never throws.
export function parseHealth(body: unknown): HealthSnapshot {
  if (!body || typeof body !== 'object') return { ok: false, nodeCount: 0 }
  const b = body as Record<string, unknown>
  if (b.ok !== true) return { ok: false, nodeCount: 0 }

  let nodeCount = 0
  if (Array.isArray(b.projects)) {
    for (const p of b.projects) {
      const n = (p as Record<string, unknown>)?.nodeCount
      if (typeof n === 'number' && Number.isFinite(n)) nodeCount += n
    }
  } else if (typeof b.nodeCount === 'number' && Number.isFinite(b.nodeCount)) {
    nodeCount = b.nodeCount
  }
  return { ok: true, nodeCount }
}

export type StatusState =
  | { kind: 'up'; nodeCount: number }
  | { kind: 'down' }
  | { kind: 'checking' }

// Map a poll state to the status-bar label + tooltip. Codicons (`$(...)`) render
// in the status bar; the strings are otherwise plain, so this maps cleanly in a
// unit test. Node counts are thousands-separated for readability.
export function statusText(state: StatusState): { text: string; tooltip: string } {
  switch (state.kind) {
    case 'up': {
      const count = state.nodeCount.toLocaleString('en-US')
      return {
        text: `$(circle-filled) NEAT ${count}`,
        tooltip: `NEAT daemon up — ${count} node${state.nodeCount === 1 ? '' : 's'} in the graph. Click to configure the MCP server.`,
      }
    }
    case 'down':
      return {
        text: '$(circle-slash) NEAT offline',
        tooltip:
          'NEAT daemon not reachable. Start it with `neat <path>` or `neatd start`, or set `neat.daemonUrl`. Click to configure the MCP server.',
      }
    case 'checking':
      return {
        text: '$(sync~spin) NEAT',
        tooltip: 'Checking the NEAT daemon…',
      }
  }
}

// Join a base daemon URL with the `/health` path, tolerating a trailing slash.
export function healthUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return `${trimmed}/health`
}

// One poll. Returns an up/down state; never throws. `fetchImpl` defaults to the
// host's global `fetch` (present in the VS Code extension host on Node 20) and is
// injected in tests. Sends the bearer when a token is configured — harmless on
// the always-open `/health`, correct if a future daemon gates it.
export async function pollHealth(
  base: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<StatusState> {
  try {
    const headers: Record<string, string> = {}
    if (token && token.length > 0) headers.Authorization = `Bearer ${token}`
    const res = await fetchImpl(healthUrl(base || DEFAULT_DAEMON_URL), { headers })
    if (!res.ok) return { kind: 'down' }
    const snap = parseHealth(await res.json())
    return snap.ok ? { kind: 'up', nodeCount: snap.nodeCount } : { kind: 'down' }
  } catch {
    return { kind: 'down' }
  }
}

// Poll cadence with backoff. Steady 10s when the daemon answers; on a miss, back
// off 10s → 20s → 40s → 60s (capped) so a stopped daemon isn't hammered. Pure so
// the schedule is unit-testable; the extension drives it with setTimeout.
export const BASE_INTERVAL_MS = 10_000
export const MAX_INTERVAL_MS = 60_000

export function nextInterval(state: StatusState, currentMs: number): number {
  if (state.kind === 'up') return BASE_INTERVAL_MS
  return Math.min(Math.max(currentMs, BASE_INTERVAL_MS) * 2, MAX_INTERVAL_MS)
}
