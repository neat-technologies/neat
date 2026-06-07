// The /projects payload carries a status per ADR-051. 'active' is the healthy
// state; 'broken' (dead path) and 'paused' both yield an empty/erroring graph.
export interface ProjectEntry { name: string; status?: 'active' | 'paused' | 'broken' }

// web-multi-project §2.3 — pick the project to land on when neither the URL
// nor localStorage named one. Prefer the first *active* project so we never
// open onto a broken/paused one and blank the dashboard (#419). If none are
// active, fall back to the first available project. An empty registry
// resolves to null — there is no project named 'default', and requesting one
// just 404s and floods the toaster (#461). Shared between AppShell and
// IncidentsClient so both cold-load surfaces resolve identically.
export function resolveProjectFromList(list: ProjectEntry[]): string | null {
  const active = list.find((p) => p?.name && p.status === 'active')
  if (active?.name) return active.name
  const firstNamed = list.find((p) => p?.name)
  if (firstNamed?.name) return firstNamed.name
  return null
}
