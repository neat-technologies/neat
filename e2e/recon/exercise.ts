#!/usr/bin/env tsx
// Recon exerciser spike (R-R.1). Throwaway — not wired into CI, not merged.
//
// Generalises e2e/brief/load.ts: instead of a hand-written journey list for one
// app, it reads the routes NEAT already extracted (RouteNodes) from a running
// daemon, fires one request per declared route at the app, then re-reads the
// graph and reports, per route, whether runtime evidence materialized:
//
//   exercised   the request got an HTTP response (any status)
//   live        the RouteNode gained an OBSERVED inbound CONTAINS edge from its
//               service — ingest fuses a SERVER span onto the declared route by
//               (method, template), ingest.ts findRouteNodeByHttpRoute
//   downstream  OBSERVED edges leaving the route's handler FILE node
//               (file:<service>:<path>) — call-site attribution lands calls on
//               files, not on the route, so the route itself has no outbound
//
// A route that answered but never materialized OBSERVED is the interesting
// finding: either the app isn't instrumented on that path, or the server span
// doesn't fuse onto the extracted RouteNode (path-template mismatch, framework
// gap). That is the signal a Recon gate would act on.
//
// Env:
//   NEAT_CORE_URL    daemon REST base (default http://localhost:8080)
//   NEAT_AUTH_TOKEN  bearer, if the daemon requires one
//   APP_BASE         the app under test (default http://localhost:3000)
//   SERVICE          only exercise routes owned by this service (optional)
//   SETTLE_MS        wait after the last request before re-reading (default 8000)
//   PARAM_VALUE      value substituted for every path parameter (default 1)
//   REPORT           write the JSON report here (optional)

const CORE = process.env.NEAT_CORE_URL ?? 'http://localhost:8080'
const APP = process.env.APP_BASE ?? 'http://localhost:3000'
const SERVICE = process.env.SERVICE
const SETTLE_MS = Number.parseInt(process.env.SETTLE_MS ?? '8000', 10)
const PARAM = process.env.PARAM_VALUE ?? '1'
const auth: Record<string, string> = process.env.NEAT_AUTH_TOKEN
  ? { authorization: `Bearer ${process.env.NEAT_AUTH_TOKEN}` }
  : {}

type Node = { id: string; type: string; service?: string; method?: string; pathTemplate?: string; path?: string; line?: number; framework?: string }
type Edge = { id?: string; source: string; target: string; type: string; provenance: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function core<T>(path: string): Promise<T> {
  const r = await fetch(`${CORE}${path}`, { headers: auth })
  if (!r.ok) throw new Error(`${path} → ${r.status}`)
  return (await r.json()) as T
}

// Fill every path parameter shape the extractors emit: Express `:id`, OpenAPI /
// Fastify `{id}`, Next.js `[id]` and `[...slug]`. A wildcard becomes the param.
export function concretePath(template: string, value = PARAM): string {
  return template
    .replace(/\[\.\.\.[^\]]+\]/g, value)
    .replace(/\[[^\]]+\]/g, value)
    .replace(/\{[^}]+\}/g, value)
    .replace(/:[A-Za-z_][A-Za-z0-9_]*\??/g, value)
    .replace(/\*+/g, value)
}

// A method-agnostic route (`ALL`) is exercised with GET; a body-taking method
// gets an empty JSON object — enough to reach the handler and emit a span, not to
// pass validation. Generating *valid* inputs is R-R.2's job (OpenAPI input-gen).
function requestFor(n: Node): { method: string; url: string; init: RequestInit } {
  const method = !n.method || n.method === 'ALL' ? 'GET' : n.method
  const init: RequestInit = { method }
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    init.headers = { 'content-type': 'application/json' }
    init.body = '{}'
  }
  return { method, url: `${APP}${concretePath(n.pathTemplate ?? '/')}`, init }
}

async function observedEdges(id: string): Promise<{ inbound: Edge[]; outbound: Edge[] }> {
  try {
    const e = await core<{ inbound: Edge[]; outbound: Edge[] }>(`/graph/edges/${encodeURIComponent(id)}`)
    const keep = (x: Edge) => x.provenance === 'OBSERVED'
    return { inbound: e.inbound.filter(keep), outbound: e.outbound.filter(keep) }
  } catch {
    return { inbound: [], outbound: [] }
  }
}

async function main(): Promise<void> {
  const g = await core<{ nodes: Node[]; edges: Edge[] }>('/graph')
  const routes = g.nodes.filter((n) => n.type === 'RouteNode' && (!SERVICE || n.service === SERVICE))
  if (routes.length === 0) {
    console.error(`no RouteNodes${SERVICE ? ` for service ${SERVICE}` : ''} — run neat init on the app first`)
    process.exit(2)
  }

  const before = new Map<string, number>()
  for (const r of routes) {
    const e = await observedEdges(r.id)
    before.set(r.id, e.inbound.length + e.outbound.length)
  }

  const fired: Record<string, { status: number | null; ms: number; error?: string; url: string }> = {}
  for (const r of routes) {
    const { url, init } = requestFor(r)
    const t0 = Date.now()
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
      await res.arrayBuffer().catch(() => undefined)
      fired[r.id] = { status: res.status, ms: Date.now() - t0, url }
    } catch (err) {
      fired[r.id] = { status: null, ms: Date.now() - t0, error: (err as Error).message, url }
    }
  }

  await sleep(SETTLE_MS)

  const rows = []
  for (const r of routes) {
    const e = await observedEdges(r.id)
    const file = r.service && r.path ? `file:${r.service}:${r.path}` : null
    const fe = file ? await observedEdges(file) : { inbound: [], outbound: [] }
    const total = e.inbound.length + e.outbound.length
    const f = fired[r.id]!
    rows.push({
      route: r.id,
      declaredAt: r.path ? `${r.path}${r.line ? `:${r.line}` : ''}` : null,
      framework: r.framework ?? null,
      request: f.url,
      status: f.status,
      error: f.error ?? null,
      exercised: f.status !== null,
      observedBefore: before.get(r.id) ?? 0,
      observedAfter: total,
      // New runtime evidence caused by this run, not evidence that was already there.
      materialized: total > (before.get(r.id) ?? 0),
      live: e.inbound.some((x) => x.type === 'CONTAINS'),
      handlerFile: file,
      downstream: fe.outbound.map((x) => `${x.type}→${x.target}`),
    })
  }

  const exercised = rows.filter((r) => r.exercised)
  const summary = {
    core: CORE,
    app: APP,
    service: SERVICE ?? null,
    declared: rows.length,
    exercised: exercised.length,
    materialized: rows.filter((r) => r.materialized).length,
    withDownstream: rows.filter((r) => r.downstream.length > 0).length,
    answeredButDark: exercised.filter((r) => !r.materialized).map((r) => r.route),
    unreachable: rows.filter((r) => !r.exercised).map((r) => r.route),
  }
  for (const r of rows) {
    const mark = r.materialized ? 'OBSERVED' : r.exercised ? 'dark    ' : 'no-reply'
    console.log(`${mark}  ${String(r.status ?? '-').padStart(3)}  ${r.route}  ${r.downstream.slice(0, 3).join(', ')}`)
  }
  console.log(JSON.stringify(summary, null, 2))
  if (process.env.REPORT) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.REPORT, JSON.stringify({ summary, rows }, null, 2))
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
