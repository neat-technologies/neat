// Per-daemon profile proxy (ADR-101). One GUI drives many daemons: there is no
// single hardcoded core base anymore — the API base IS the selected profile's
// `endpoint`, resolved per request from the `?project=<label>` query. A daemon
// serves its one project at the ROOT (ADR-096), so the proxy carries no
// per-project path prefix.
//
// Profiles come from discovery: each per-project daemon writes
// `~/.neat/daemons/<project>.json` (core's daemon.ts). This module enumerates
// that directory and resolves a label to its daemon endpoint. The
// `~/.neat/projects.json` registry dependency is gone.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const DEMO = process.env.NEAT_DEMO === '1'

// A discovered daemon, flattened to a routing profile. Mirrors core's
// DaemonRecord fields the proxy needs.
export interface DaemonProfile {
  project: string
  endpoint: string
  status: 'running' | 'stopped'
}

// `~/.neat/daemons` — the discovery directory core's daemon.ts writes to.
// Honors NEAT_HOME exactly as core does so a sandboxed home lands here too.
function daemonsDiscoveryDir(): string {
  const env = process.env.NEAT_HOME
  const base = env && env.length > 0 ? path.resolve(env) : path.join(os.homedir(), '.neat')
  return path.join(base, 'daemons')
}

interface DaemonRecordLike {
  project?: string
  status?: 'running' | 'stopped'
  ports?: { rest?: number }
}

// Enumerate `~/.neat/daemons/*.json` → one profile per daemon. The discovery
// file is a HINT (a crashed daemon can leave a stale `running`), so reachability
// is confirmed by the client's resolveProfile probe before auto-selecting — the
// enumerator just reports what it found. A malformed/partial record is treated
// as "no daemon here" rather than failing the whole enumeration.
export async function discoverProfiles(): Promise<DaemonProfile[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(daemonsDiscoveryDir())
  } catch {
    // No discovery directory → no per-project daemons running (ADR-101: a
    // legacy multi-project daemon writes none, so it surfaces as the empty
    // state, not a compatibility path).
    return []
  }
  const profiles: DaemonProfile[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(path.join(daemonsDiscoveryDir(), entry), 'utf8')
      const rec = JSON.parse(raw) as DaemonRecordLike
      const rest = rec.ports?.rest
      if (typeof rec.project === 'string' && typeof rest === 'number') {
        profiles.push({
          project: rec.project,
          endpoint: `http://127.0.0.1:${rest}`,
          status: rec.status === 'stopped' ? 'stopped' : 'running',
        })
      }
    } catch {
      // skip — a corrupt record is "no daemon recorded here."
    }
  }
  profiles.sort((a, b) => a.project.localeCompare(b.project))
  return profiles
}

// Resolve the daemon endpoint for a profile label (the project name carried in
// `?project=`). Returns null when no discovered daemon matches that label — the
// caller then serves the fixture (DEMO) or a 502.
export async function endpointForProject(project: string | null): Promise<string | null> {
  if (!project) return null
  const profiles = await discoverProfiles()
  return profiles.find((p) => p.project === project)?.endpoint ?? null
}

// Forward the operator's bearer (ADR-073 §3) and the SSE caller's Last-Event-ID
// so the daemon sees what the browser sent. Other headers are upstream-managed.
const FORWARD_HEADERS = ['authorization', 'last-event-id'] as const

function pickForwardableHeaders(req?: Request): HeadersInit | undefined {
  if (!req) return undefined
  const out: Record<string, string> = {}
  for (const name of FORWARD_HEADERS) {
    const v = req.headers.get(name)
    if (v) out[name] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export async function proxyGet(
  url: string,
  fallback: () => Response,
  req?: Request,
): Promise<Response> {
  try {
    const upstream = await fetch(url, { cache: 'no-store', headers: pickForwardableHeaders(req) })
    const body = await upstream.text()
    return new Response(body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    })
  } catch {
    if (DEMO) return fallback()
    return Response.json({ error: 'failed to reach neat daemon' }, { status: 502 })
  }
}

// Resolve the active profile's endpoint from the `?project=<label>` query, then
// proxy to it at the daemon ROOT (ADR-101 — no `/projects/:name` prefix).
// `subpath` starts with `/` (e.g. `/graph`, or `/graph/node/${id}?depth=…`).
// When no discovered daemon matches the label, serve the fixture in DEMO, else
// a 502 — the consumer's null-project gate keeps this from firing on a cold,
// unresolved session.
export async function proxyProfile(
  request: Request,
  subpath: string,
  fallback: () => Response,
): Promise<Response> {
  const project = new URL(request.url).searchParams.get('project')
  const endpoint = await endpointForProject(project)
  if (!endpoint) {
    if (DEMO) return fallback()
    return Response.json(
      { error: 'no reachable daemon for the selected profile', project },
      { status: 502 },
    )
  }
  return proxyGet(`${endpoint}${subpath}`, fallback, request)
}
