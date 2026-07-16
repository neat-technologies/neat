import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { resetGraph, getGraph } from '../src/graph.js'
import { buildApi } from '../src/api.js'
import { extractFromDirectory } from '../src/extract.js'
import { getBlastRadius } from '../src/traverse.js'
import type { NeatGraph } from '../src/graph.js'

// get_blast_radius correctness over the REAL extracted graph, the third leg of
// the traversal trio (get_root_cause and get_dependencies already have real-graph
// coverage; this closes the gap). Blast radius is the INBOUND question — "what
// breaks if this node changes" — so it must cascade UP the dependency chain, and
// it KEEPS CONTAINS (an affected file's owning service is genuinely impacted,
// file-awareness §36), where get_dependencies filters it (ADR-140). The sharp
// case is a shared resource: the demo database is reached by service-b directly
// and by service-a transitively (service-a → CALLS → service-b → db), so its
// blast radius must span BOTH services, not just the immediate neighbour.

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../demo')

describe('get_blast_radius over the real demo graph', () => {
  let graph: NeatGraph
  let app: FastifyInstance

  beforeAll(async () => {
    resetGraph()
    graph = getGraph()
    await extractFromDirectory(graph, DEMO)
    app = await buildApi({ graph, scanPath: DEMO })
  })

  it('a shared database cascades its blast radius up through BOTH dependent services', () => {
    // demo chain: service-a → CALLS → service-b → CONNECTS_TO → payments-db.
    // Break the db and everything upstream is at risk: the file that connects to
    // it, service-b that owns that file, the file in service-a that calls
    // service-b, and service-a itself. The transitive reach across the service
    // boundary is the whole point of blast radius.
    const r = getBlastRadius(graph, 'database:payments-db')
    const ids = r.affectedNodes.map((n) => n.nodeId)

    expect(r.totalAffected).toBe(4)
    // The directly-connecting service, one hop past its file.
    expect(ids).toContain('service:service-b')
    // The TRANSITIVE dependent across the service boundary — service-a never
    // touches the db itself; it's at risk only because it calls service-b.
    expect(ids).toContain('service:service-a')
    // The call-site file in the upstream service is on the path too.
    expect(ids).toContain('file:service-a:index.js')
  })

  it('keeps CONTAINS so an affected file drags in its owning service (§36)', () => {
    // get_dependencies filters CONTAINS (a service doesn't depend on its own
    // files); blast radius must NOT — walked inbound, a file being affected means
    // its owning service is affected. So service nodes reached only via CONTAINS
    // still surface here.
    const r = getBlastRadius(graph, 'database:payments-db')
    const services = r.affectedNodes.filter((n) => n.nodeId.startsWith('service:'))
    expect(services.length).toBeGreaterThanOrEqual(2)
  })

  it('orders affected nodes by shortest-path distance from the origin', () => {
    const r = getBlastRadius(graph, 'database:payments-db')
    const distances = r.affectedNodes.map((n) => n.distance)
    const sorted = [...distances].sort((a, b) => a - b)
    expect(distances).toEqual(sorted)
    // service-b (direct owner) is strictly closer than service-a (transitive).
    const b = r.affectedNodes.find((n) => n.nodeId === 'service:service-b')!
    const a = r.affectedNodes.find((n) => n.nodeId === 'service:service-a')!
    expect(b.distance).toBeLessThan(a.distance)
  })

  it('a mid-chain service reaches only its upstream callers, not itself', () => {
    // Blast radius of service-b is who depends on service-b: service-a (the
    // caller) and its file. service-b is the origin and never appears in its own
    // affected set.
    const r = getBlastRadius(graph, 'service:service-b')
    const ids = r.affectedNodes.map((n) => n.nodeId)
    expect(ids).toContain('service:service-a')
    expect(ids).not.toContain('service:service-b')
  })

  it('returns an empty set (not an error) for a node absent from the graph', () => {
    const r = getBlastRadius(graph, 'database:does-not-exist')
    expect(r.totalAffected).toBe(0)
    expect(r.affectedNodes).toHaveLength(0)
  })

  it('surfaces the same cascade through the /graph/blast-radius endpoint', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/blast-radius/database:payments-db',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { totalAffected: number; affectedNodes: { nodeId: string }[] }
    expect(body.totalAffected).toBe(4)
    const ids = body.affectedNodes.map((n) => n.nodeId)
    expect(ids).toContain('service:service-b')
    expect(ids).toContain('service:service-a')
  })

  it('the endpoint 404s on an unknown node rather than returning an empty set', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/blast-radius/database:does-not-exist',
    })
    expect(res.statusCode).toBe(404)
  })
})
