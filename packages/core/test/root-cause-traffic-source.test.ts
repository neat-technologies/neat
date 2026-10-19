import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { ErrorEvent, GraphEdge, GraphNode } from '@neat.is/types'
import { EdgeType, NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { getRootCause } from '../src/traverse.js'
import { incidentLead } from '../src/incident-lead.js'

// ADR-264 amendment — SREGym valkey_auth_disruption, bench pass 1 on 57c6005. The
// lead moved to frontend, but get_root_cause(service:frontend) still answered
// "load-generator is the root cause: it overloads the failing subgraph, and the
// alerting node flagd is a downstream symptom … errors reach flagd from its
// callers (48), none originate there; its inbound p95 4992ms is saturated" and
// said to throttle the load generator. Those 48 errors and that p95 are the load
// generator's own calls to flagd's OFREP port timing out, chronic on astronomy-shop.
// The traffic-source test lived only in the lead; root cause's load-origin step
// now reads the same predicate, so a client is never named as the origin.

const NOW = Date.parse('2026-10-18T12:22:10.000Z')
const SEEN = '2026-10-18T12:22:05.000Z'

const OFREP_ERROR =
  "HTTPConnectionPool(host='flagd', port=8016): Max retries exceeded with url: /ofrep/v1/evaluate/flags/loadGeneratorFloodHomepage (Caused by NameResolutionError(\"HTTPConnection(host='flagd', port=8016): Failed to resolve 'flagd' ([Errno -3] Temporary failure in name resolution)\"))"

function svc(g: NeatGraph, name: string): void {
  g.addNode(`service:${name}`, { id: `service:${name}`, type: NodeType.ServiceNode, name, language: 'go' } as GraphNode)
}
function calls(
  g: NeatGraph,
  from: string,
  to: string,
  count: number,
  errors: number,
  p95: number,
  lastError?: string,
): void {
  const id = `CALLS:OBSERVED:${from}->${to}`
  g.addEdgeWithKey(id, from, to, {
    id,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    callCount: count,
    lastObserved: SEEN,
    signal: {
      spanCount: count,
      errorCount: errors,
      latencyMs: { p50: Math.min(p95, 5), p95 },
      ...(lastError ? { lastError: { message: lastError, at: SEEN } } : {}),
    },
  } as GraphEdge)
}

// load-generator drives frontend-proxy and fails against flagd's OFREP port;
// frontend fails against flagd too, which seeds the walk there.
function valkeyAuth(): { g: NeatGraph; incidents: ErrorEvent[] } {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const s of ['load-generator', 'frontend-proxy', 'frontend', 'flagd']) svc(g, s)
  calls(g, 'service:load-generator', 'service:frontend-proxy', 702, 12, 25)
  calls(g, 'service:load-generator', 'service:flagd', 80, 48, 4992, OFREP_ERROR)
  calls(g, 'service:frontend-proxy', 'service:frontend', 700, 24, 60)
  calls(g, 'service:frontend', 'service:flagd', 40, 6, 4800)
  const incidents: ErrorEvent[] = []
  for (let i = 0; i < 6; i++) {
    incidents.push({
      id: `f${i}:s`,
      timestamp: `2026-10-18T12:22:0${i}.000Z`,
      service: 'frontend',
      traceId: `f${i}`,
      spanId: 's',
      errorMessage: 'gRPC UNAVAILABLE',
      affectedNode: 'service:frontend',
    } as ErrorEvent)
  }
  for (let i = 0; i < 48; i++) {
    incidents.push({
      id: `l${i}:s`,
      timestamp: `2026-10-18T12:21:${String(10 + (i % 50)).padStart(2, '0')}.000Z`,
      service: 'load-generator',
      traceId: `l${i}`,
      spanId: 's',
      errorMessage: OFREP_ERROR,
      affectedNode: 'service:load-generator',
    } as ErrorEvent)
  }
  return { g, incidents }
}

describe('root cause never names a traffic source as the load origin (ADR-264)', () => {
  it('valkey_auth_disruption: the load comes from a client, pointed at what its calls fail against', () => {
    const { g, incidents } = valkeyAuth()
    const res = getRootCause(g, 'service:frontend', undefined, incidents, { now: NOW })!
    expect(res.rootCauseNode).not.toBe('service:load-generator')
    expect(res.candidates?.map((c) => c.node)).not.toContain('service:load-generator')
    expect(res.rootCauseNode).toBe('service:flagd')
    expect(res.rootCauseReason).toContain('No service drives this load: it comes from a client, load-generator')
    expect(res.rootCauseReason).toContain("load-generator's calls fail against flagd (48 errors, latest: HTTPConnectionPool(host='flagd', port=8016)")
    expect(res.fixRecommendation).toMatch(/^Check why flagd fails load-generator's calls/)
    expect(res.fixRecommendation).not.toMatch(/Reduce or throttle/)
  })

  it('the lead and root cause agree on what a traffic source is', () => {
    const { g, incidents } = valkeyAuth()
    const lead = incidentLead(g, incidents)
    expect(lead.trafficSources.map((t) => t.node)).toEqual(['service:load-generator'])
    expect(lead.ranked.map((r) => r.node)).not.toContain('service:load-generator')
  })

  it('a service that drives the load is still the origin (control)', () => {
    const { g, incidents } = valkeyAuth()
    // Something calls load-generator now, so it is a service, not a client.
    svc(g, 'cron')
    calls(g, 'service:cron', 'service:load-generator', 5, 0, 10)
    const res = getRootCause(g, 'service:frontend', undefined, incidents, { now: NOW })!
    expect(res.rootCauseReason).toContain('overloads the failing subgraph')
  })
})
