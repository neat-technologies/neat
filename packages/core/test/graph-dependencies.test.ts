import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { resetGraph, getGraph } from '../src/graph.js'
import { buildApi } from '../src/api.js'
import { extractFromDirectory } from '../src/extract.js'

// The first behavioural coverage for GET /graph/dependencies (the endpoint the
// MCP `get_dependencies` tool wraps). It had none — asserted only via the tool's
// stubbed HttpClient, never against a real extracted graph. This drives the real
// endpoint over the `demo/` fixture and checks CORRECT ANSWERS, not just shape.
//
// It reflects the §36 refinement (ADR-140): `getTransitiveDependencies` walks
// THROUGH CONTAINS to reach a called service's file-grained targets (so the real
// transitive deps still surface), but does not REPORT a structural CONTAINS edge
// as a dependency — a service doesn't depend on its own files. get_blast_radius
// keeps CONTAINS (an affected file's owning service is genuinely impacted).

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../demo')

interface Dep {
  nodeId: string
  distance: number
  edgeType: string
  provenance: string
}
interface DepsResponse {
  origin: string
  depth: number
  dependencies: Dep[]
  total: number
}

describe('GET /graph/dependencies — correct answers over the real demo graph', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    resetGraph()
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO)
    app = await buildApi({ graph, scanPath: DEMO })
  })

  async function deps(nodeId: string, depth?: number): Promise<DepsResponse> {
    const q = depth === undefined ? '' : `?depth=${depth}`
    const res = await app.inject({
      method: 'GET',
      url: `/graph/dependencies/${encodeURIComponent(nodeId)}${q}`,
    })
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.body) as DepsResponse
  }

  it('depth 1 from a caller file is exactly its direct CALLS target', async () => {
    const r = await deps('file:service-a:index.js', 1)
    expect(r.dependencies).toHaveLength(1)
    expect(r.dependencies[0]).toMatchObject({
      nodeId: 'service:service-b',
      distance: 1,
      edgeType: 'CALLS',
      provenance: 'EXTRACTED',
    })
  })

  it('reaches the real transitive dependency (the database) at depth 3', async () => {
    const r = await deps('file:service-a:index.js', 3)
    // service-a → CALLS → service-b → (file-first) → file that CONNECTS_TO the db.
    const db = r.dependencies.find((d) => d.nodeId === 'database:payments-db')
    expect(db, 'database:payments-db must be reachable transitively').toBeDefined()
    expect(db).toMatchObject({ edgeType: 'CONNECTS_TO', provenance: 'EXTRACTED', distance: 3 })
  })

  it('does not report structural CONTAINS children as dependencies (§36 refinement, ADR-140)', async () => {
    const r = await deps('file:service-a:index.js', 3)
    // A service doesn't depend on its own files. No CONTAINS edge is reported as
    // a dependency — the traversal still walks THROUGH them to reach the real
    // transitive deps (the database above), it just doesn't surface the callee's
    // structural files as noise.
    expect(r.dependencies.every((d) => d.edgeType !== 'CONTAINS')).toBe(true)
    const noise = ['file:service-b:Dockerfile', 'file:service-b:otel.js', 'file:service-b:index.js']
    expect(r.dependencies.filter((d) => noise.includes(d.nodeId))).toHaveLength(0)
  })

  it('a service depends on its declared config (CONFIGURED_BY)', async () => {
    const r = await deps('service:service-b', 1)
    const cfg = r.dependencies.find((d) => d.nodeId === 'config:service-b/db-config.yaml')
    expect(cfg).toMatchObject({ edgeType: 'CONFIGURED_BY', distance: 1, provenance: 'EXTRACTED' })
  })

  it('respects the depth budget: depth 1 yields only distance-1 deps', async () => {
    const r = await deps('file:service-a:index.js', 1)
    expect(r.dependencies.every((d) => d.distance === 1)).toBe(true)
    const deep = await deps('file:service-a:index.js', 3)
    expect(deep.dependencies.some((d) => d.distance > 1)).toBe(true)
  })

  it('an unknown node 404s (rather than silently returning an empty set)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/dependencies/service:does-not-exist?depth=3',
    })
    expect(res.statusCode).toBe(404)
  })
})
