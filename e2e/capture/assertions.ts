#!/usr/bin/env tsx
// The make-or-break file-first assertion (file-awareness.md §4, ADR-090).
//
// Reads the capture-app project graph from neatd and asserts the file-first
// claim under real auto-instrumentations: every OBSERVED outbound edge from the
// capture-app service originates from a *file* node, not the service node. A
// single service-level CLIENT/PRODUCER edge is a failure — it means a tier's
// span reached ingest without code.*, i.e. the capture mechanism missed it.
//
// This is the gate the synthetic-span test couldn't be: it fails on
// neat.is@0.4.10 (the off-stack tiers — fetch, prisma — produce only
// service-level edges there) and passes once the layered mechanism lands.

const NEAT_BASE = process.env.NEAT_BASE ?? 'http://localhost:8080'
const PROJECT = process.env.CAPTURE_PROJECT ?? 'app'
const SERVICE = process.env.CAPTURE_SERVICE ?? 'neat-capture-app'
const TIMEOUT_MS = Number.parseInt(process.env.ASSERT_TIMEOUT_MS ?? '30000', 10)
const POLL_INTERVAL_MS = 1000

const SERVICE_ID = `service:${SERVICE}`
const FILE_PREFIX = `file:${SERVICE}:`
// The outbound edge types the capture tiers produce: HTTP/fetch/aws/sqs land
// CALLS toward a frontier/service; pg/prisma land CONNECTS_TO toward a database.
const OUTBOUND_TYPES = new Set(['CALLS', 'CONNECTS_TO'])

type GraphEdge = {
  id: string
  source: string
  target: string
  type: string
  provenance: string
  signal?: { spanCount?: number }
}
type GraphNode = { id: string; type: string }
type Graph = { nodes: GraphNode[]; edges: GraphEdge[] }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function fetchGraph(): Promise<Graph> {
  const r = await fetch(`${NEAT_BASE}/projects/${PROJECT}/graph`)
  if (!r.ok) throw new Error(`GET /projects/${PROJECT}/graph → ${r.status}`)
  return (await r.json()) as Graph
}

function observedOutbound(graph: Graph): GraphEdge[] {
  return graph.edges.filter(
    (e) =>
      e.provenance === 'OBSERVED' &&
      OUTBOUND_TYPES.has(e.type) &&
      (e.source === SERVICE_ID || e.source.startsWith(FILE_PREFIX)),
  )
}

function fail(message: string): never {
  console.error(`[assert] FAIL: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  let graph: Graph | null = null
  let outbound: GraphEdge[] = []

  // Poll until the off-stack tiers (the slowest to land) have produced edges.
  while (Date.now() < deadline) {
    try {
      graph = await fetchGraph()
      outbound = observedOutbound(graph)
      const fileGrained = outbound.filter((e) => e.source.startsWith(FILE_PREFIX))
      // Wait for a spread of tiers, not just the first edge.
      if (fileGrained.length >= 3) break
    } catch (err) {
      console.error(`[assert] poll error (will retry): ${(err as Error).message}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }

  if (!graph) fail(`could not reach ${NEAT_BASE}/projects/${PROJECT}/graph within ${TIMEOUT_MS}ms`)

  if (!graph.nodes.some((n) => n.id === SERVICE_ID)) {
    fail(`expected ${SERVICE_ID} node, found none — project '${PROJECT}' mis-registered? set CAPTURE_PROJECT`)
  }

  if (outbound.length === 0) {
    fail(`no OBSERVED CALLS/CONNECTS_TO edges from ${SERVICE_ID} within ${TIMEOUT_MS}ms — the app's spans never reached neatd`)
  }

  // The core assertion: zero service-level outbound edges. Every one must
  // originate from a file node, across all tiers (sync-wrapper, off-stack,
  // aws). A service-level edge here is the regression this gate exists to catch.
  const serviceLevel = outbound.filter((e) => e.source === SERVICE_ID)
  if (serviceLevel.length > 0) {
    const sample = serviceLevel.slice(0, 5).map((e) => `${e.type}->${e.target}`).join(', ')
    fail(
      `${serviceLevel.length} OBSERVED outbound edge(s) from ${SERVICE_ID} are service-level, ` +
        `not file-grained — a capture tier emitted a span without code.* (file-awareness.md §4). ` +
        `samples: ${sample}`,
    )
  }

  // Both shapes must be present: a database edge (pg/prisma DB tier) and a
  // calls edge (http/fetch/aws tier), so we know the assertion spans tiers and
  // isn't passing on a single instrumentation.
  const fileGrained = outbound.filter((e) => e.source.startsWith(FILE_PREFIX))
  const hasDbTier = fileGrained.some((e) => e.type === 'CONNECTS_TO')
  const hasCallTier = fileGrained.some((e) => e.type === 'CALLS')
  if (!hasDbTier) {
    fail(`no file-grained CONNECTS_TO edge — the pg/prisma DB tier didn't attribute to a file`)
  }
  if (!hasCallTier) {
    fail(`no file-grained CALLS edge — the http/fetch/aws tier didn't attribute to a file`)
  }

  console.log('[assert] OK')
  console.log(`  ${SERVICE_ID} present; ${fileGrained.length} file-grained OBSERVED outbound edge(s), 0 service-level`)
  for (const e of fileGrained.slice(0, 8)) {
    console.log(`    ${e.source}  ${e.type}-> ${e.target}  spans=${e.signal?.spanCount}`)
  }
}

main().catch((err) => {
  console.error('[assert] fatal:', err)
  process.exit(1)
})
