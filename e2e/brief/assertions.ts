#!/usr/bin/env tsx
// Reads the live brief project graph from neatd, asserts the OBSERVED tier
// looks the way the contract names. Exits non-zero with a specific message
// when the expected shape is missing — the timeout case is the failure mode
// the e2e is built to catch.

const NEAT_BASE = process.env.NEAT_BASE ?? 'http://localhost:8080'
const TIMEOUT_MS = Number.parseInt(process.env.ASSERT_TIMEOUT_MS ?? '30000', 10)
const POLL_INTERVAL_MS = 1000
const FRESHNESS_WINDOW_MS = 60_000

const BRIEF_API_ID = 'service:brief-api'

type GraphEdge = {
  id: string
  source: string
  target: string
  type: string
  provenance: string
  lastObserved?: string
  signal?: { spanCount?: number; errorCount?: number; lastObservedAgeMs?: number }
  confidence?: number
}

type Graph = { nodes: { id: string; type: string }[]; edges: GraphEdge[] }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function fetchGraph(): Promise<Graph> {
  const r = await fetch(`${NEAT_BASE}/projects/brief/graph`)
  if (!r.ok) throw new Error(`GET /projects/brief/graph → ${r.status}`)
  return (await r.json()) as Graph
}

function pickObservedFromBriefApi(graph: Graph): GraphEdge[] {
  return graph.edges.filter(
    (e) => e.provenance === 'OBSERVED' && e.source === BRIEF_API_ID,
  )
}

function fail(message: string): never {
  console.error(`[assert] FAIL: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  let graph: Graph | null = null
  let observed: GraphEdge[] = []

  while (Date.now() < deadline) {
    try {
      graph = await fetchGraph()
      observed = pickObservedFromBriefApi(graph)
      if (observed.length > 0) break
    } catch (err) {
      console.error(`[assert] poll error (will retry): ${(err as Error).message}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }

  if (!graph) fail(`could not reach ${NEAT_BASE}/projects/brief/graph within ${TIMEOUT_MS}ms`)

  // 1. brief-api service node exists.
  if (!graph.nodes.some((n) => n.id === BRIEF_API_ID)) {
    fail(`expected ${BRIEF_API_ID} node, found none — registry mis-routing? See docs/contracts/observed-e2e.md`)
  }

  // 2. At least one OBSERVED edge from brief-api.
  if (observed.length === 0) {
    fail(
      `expected at least one OBSERVED edge from ${BRIEF_API_ID}, found none within ${TIMEOUT_MS}ms — ` +
        `the OTLP path between Brief and neatd is silent`,
    )
  }

  // 3. The edge carries non-zero spanCount and a fresh lastObserved.
  const now = Date.now()
  const fresh = observed.filter((e) => {
    const spanCount = e.signal?.spanCount ?? 0
    if (spanCount <= 0) return false
    if (!e.lastObserved) return false
    const age = now - Date.parse(e.lastObserved)
    return Number.isFinite(age) && age >= 0 && age <= FRESHNESS_WINDOW_MS
  })

  if (fresh.length === 0) {
    const sample = observed[0]
    fail(
      `OBSERVED edges exist from ${BRIEF_API_ID} but none are fresh (within ${FRESHNESS_WINDOW_MS}ms) ` +
        `with spanCount > 0. sample id=${sample.id} signal=${JSON.stringify(sample.signal)} lastObserved=${sample.lastObserved}`,
    )
  }

  // 4. Divergences endpoint answers (ADR-060). The OBSERVED tier should be
  // reflected in the divergence query.
  const divResp = await fetch(`${NEAT_BASE}/projects/brief/graph/divergences`)
  if (!divResp.ok) {
    fail(`/projects/brief/graph/divergences returned ${divResp.status} — expected 200 per ADR-060`)
  }

  console.log(`[assert] OK`)
  console.log(`  brief-api node present`)
  console.log(`  ${observed.length} OBSERVED edge(s) from ${BRIEF_API_ID}, ${fresh.length} fresh`)
  for (const e of fresh.slice(0, 5)) {
    console.log(`    ${e.id}  spans=${e.signal?.spanCount} errs=${e.signal?.errorCount} lastObserved=${e.lastObserved}`)
  }
}

main().catch((err) => {
  console.error('[assert] fatal:', err)
  process.exit(1)
})
