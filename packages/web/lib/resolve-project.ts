// A per-daemon profile (ADR-101). The same shape local and hosted: the GUI's
// API base is the selected profile's `endpoint`, served at the daemon ROOT
// (ADR-096 — a daemon serves its one project at the root, no `/projects/:name`
// prefix). `project` is the profile's label. `status` is the daemon record's
// liveness (`running | stopped`) from `~/.neat/daemons/<project>.json` — NOT
// ADR-051's `active | paused | broken` registry vocabulary, which ADR-101
// drops for the GUI. `authToken` is optional: local discovery yields none
// (laptop dev), hosted supplies a per-profile bearer.
export interface Profile {
  project: string
  endpoint: string
  status?: 'running' | 'stopped'
  authToken?: string
}

// Coerce the `/api/profiles` payload (a bare array, or `{ profiles: [...] }`)
// into a clean Profile list. Shared by AppShell and IncidentsClient so both
// cold-load surfaces read the discovery enumerator identically.
export function asProfileList(data: unknown): Profile[] {
  const raw = Array.isArray(data)
    ? data
    : Array.isArray((data as { profiles?: unknown })?.profiles)
      ? (data as { profiles: unknown[] }).profiles
      : []
  const out: Profile[] = []
  for (const item of raw) {
    const p = item as Partial<Profile>
    if (typeof p?.project === 'string' && typeof p?.endpoint === 'string') {
      out.push({
        project: p.project,
        endpoint: p.endpoint,
        status: p.status === 'stopped' ? 'stopped' : 'running',
        ...(typeof p.authToken === 'string' ? { authToken: p.authToken } : {}),
      })
    }
  }
  return out
}

// web-multi-project §2.3 / §2.4 (ADR-101) — resolve the active profile from the
// discovered list. The discovery file is a HINT, not truth: a daemon that
// crashed without rewriting its record leaves a stale `status:"running"`, so we
// confirm reachability with a cheap probe on the profile `endpoint` before
// auto-selecting and never cold-open onto a dead endpoint (#419 in new
// clothes).
//
// `preferredName` is the URL/localStorage label (§2.4). It resolves to the
// matching profile only when that profile is reachable; a stored name with no
// matching reachable daemon resolves to `null`, not an error. With no preferred
// name we auto-select the first `running` AND reachable profile; a `stopped`
// or unreachable profile is shown in the switcher but never auto-selected.
//
// Injecting `isReachable` keeps this a pure function of its inputs — it can be
// unit-tested directly without rendering or real network.
export async function resolveProfile(
  list: Profile[],
  isReachable: (p: Profile) => Promise<boolean>,
  preferredName?: string | null,
): Promise<Profile | null> {
  if (preferredName) {
    const named = list.find((p) => p?.project === preferredName)
    if (!named) return null
    return (await isReachable(named)) ? named : null
  }
  for (const p of list) {
    if (!p?.project || p.status === 'stopped') continue
    if (await isReachable(p)) return p
  }
  return null
}
