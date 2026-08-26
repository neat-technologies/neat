import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, extractedEdgeId, fileId, routeId } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'route-approx')

// ADR-219 — reconstruction-fidelity grading for the client↔route matcher.
//
// The fixture is a `payments-api` service declaring `/health`, `/charges`,
// `/charges/:id`, `/:id`, and a `payments-client` calling it five ways: a fully
// literal URL, a genuine path param under a literal anchor, a base URL held in a
// const, a computed single path segment, and a base URL from a runtime argument.
// These lock the four outcomes: a fully-resolved match stays 0.85, a base-in-a-
// const resolves (the silent miss), an all-dynamic path refuses under the floor
// and surfaces under diagnostics (the confident false positive), and an
// unresolvable base is recorded rather than silently dropped.
describe('client↔route reconstruction fidelity (ADR-219)', () => {
  beforeEach(() => resetGraph())

  const withFloor = async (floor: string | undefined, fn: () => Promise<void> | void) => {
    const prev = process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    if (floor === undefined) delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    else process.env.NEAT_EXTRACTED_PRECISION_FLOOR = floor
    try {
      await fn()
    } finally {
      if (prev === undefined) delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
      else process.env.NEAT_EXTRACTED_PRECISION_FLOOR = prev
    }
  }

  const clientFile = fileId('payments-client', 'catalog.js')
  const bareRoute = routeId('payments-api', 'GET', '/:id')

  it('resolves a base URL held in a const, recovering the silently-dropped route edge', async () => {
    await withFloor(undefined, async () => {
      const graph = getGraph()
      await extractFromDirectory(graph, FIXTURES)

      const edgeId = extractedEdgeId(
        fileId('payments-client', 'charges.js'),
        routeId('payments-api', 'GET', '/charges'),
        EdgeType.CALLS,
      )
      expect(graph.hasEdge(edgeId)).toBe(true)
      const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
      // The base host came from the const, so the reconstruction is exact — it
      // grades verified-call-site, not the approximate tier.
      expect(edge.confidence).toBeCloseTo(0.85, 2)
      expect(edge.evidence?.approximate).toBeUndefined()
    })
  })

  it('refuses the computed-segment false positive under the default precision floor', async () => {
    await withFloor(undefined, async () => {
      const graph = getGraph()
      await extractFromDirectory(graph, FIXTURES)

      // The lone `/:param` from a computed segment must not mint a confident edge
      // to the bare `/:id` route.
      expect(graph.hasEdge(extractedEdgeId(clientFile, bareRoute, EdgeType.CALLS))).toBe(false)

      // And no confident route edge from that file to anything.
      let confidentRouteEdges = 0
      graph.forEachEdge((_id, attrs, source, target) => {
        const e = attrs as GraphEdge
        if (e.type !== EdgeType.CALLS) return
        if (source !== clientFile) return
        if (!target.startsWith('route:')) return
        if (e.confidence >= 0.7) confidentRouteEdges++
      })
      expect(confidentRouteEdges).toBe(0)
    })
  })

  it('keeps a literal match and a genuine path-param match at verified-call-site (0.85)', async () => {
    await withFloor(undefined, async () => {
      const graph = getGraph()
      await extractFromDirectory(graph, FIXTURES)

      const literal = extractedEdgeId(
        fileId('payments-client', 'health.js'),
        routeId('payments-api', 'GET', '/health'),
        EdgeType.CALLS,
      )
      expect(graph.hasEdge(literal)).toBe(true)
      expect((graph.getEdgeAttributes(literal) as GraphEdge).confidence).toBeCloseTo(0.85, 2)

      // A literal `/charges` anchor with an interpolated id stays confident — the
      // interpolation is not load-bearing for which route it names.
      const param = extractedEdgeId(
        fileId('payments-client', 'user-lookup.js'),
        routeId('payments-api', 'GET', '/charges/:id'),
        EdgeType.CALLS,
      )
      expect(graph.hasEdge(param)).toBe(true)
      const paramEdge = graph.getEdgeAttributes(param) as GraphEdge
      expect(paramEdge.confidence).toBeCloseTo(0.85, 2)
      expect(paramEdge.evidence?.approximate).toBeUndefined()
    })
  })

  it('surfaces the computed-segment match at the approximate tier under the diagnostic floor', async () => {
    await withFloor('0', async () => {
      const graph = getGraph()
      await extractFromDirectory(graph, FIXTURES)

      const edgeId = extractedEdgeId(clientFile, bareRoute, EdgeType.CALLS)
      expect(graph.hasEdge(edgeId)).toBe(true)
      const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
      // Below the default floor — visible only because the floor is lowered — and
      // it records why the reconstruction was approximate.
      expect(edge.confidence).toBeCloseTo(0.15, 2)
      expect(edge.evidence?.approximate).toBe(true)
      expect(edge.evidence?.reason).toMatch(/path segment interpolation/)
    })
  })

  it('records an unresolvable base URL as an approximate drop, never a silent miss', async () => {
    await withFloor(undefined, async () => {
      const graph = getGraph()
      const result = await extractFromDirectory(graph, FIXTURES)

      // No confident route edge from the runtime-base call site.
      const dynamicFile = fileId('payments-client', 'dynamic-base.js')
      let routeEdges = 0
      graph.forEachEdge((_id, attrs, source, target) => {
        const e = attrs as GraphEdge
        if (e.type === EdgeType.CALLS && source === dynamicFile && target.startsWith('route:')) {
          routeEdges++
        }
      })
      expect(routeEdges).toBe(0)

      // But it is recorded as an approximate drop — surfaced on the extraction
      // result (and the rejected log when enabled) — rather than vanishing.
      const mine = result.droppedEntries.find(
        (d) =>
          d.confidenceKind === 'reconstructed-approximate' &&
          d.source === dynamicFile &&
          d.evidence.reason?.includes('base URL interpolation'),
      )
      expect(mine).toBeDefined()
    })
  })
})
