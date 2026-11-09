import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode, ErrorEvent } from '@neat.is/types'
import { EdgeType, NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { getRootCause } from '../src/traverse.js'
import { mergeObservedDeployContext } from '../src/ingest.js'

// #1400 — PRAXIS 414. recommendation starts with a wrong Neo4j host in its env and
// exits 1 before it opens any connection, so it crash-loops. Its callers see
// ECONNREFUSED; it records no outbound-failure text of its own and no outbound
// edge. By its inbound signal alone it reads as a starved load victim (errors
// from callers, STALE, emits no more than it receives), so the victim → load-
// origin move (ADR-189) used to name frontend-proxy. The only signal on the node
// is its deploy context (ADR-243). These fixtures pin that the deploy fault
// counts as the seed's own fault, and that a genuine overload still promotes the
// load origin.

const NOW = Date.parse('2026-10-12T10:10:00.000Z')

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}
function svc(g: NeatGraph, name: string): void {
  g.addNode(`service:${name}`, {
    id: `service:${name}`,
    type: NodeType.ServiceNode,
    name,
    language: 'javascript',
  } as GraphNode)
}
function calls(
  g: NeatGraph,
  from: string,
  to: string,
  opts: { count: number; err: number; stale?: boolean },
): void {
  const prov = opts.stale ? Provenance.STALE : Provenance.OBSERVED
  const key = `CALLS:${prov}:${from}->${to}`
  g.addEdgeWithKey(key, from, to, {
    id: key,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: prov,
    callCount: opts.count,
    signal: { spanCount: opts.count, errorCount: opts.err },
    lastObserved: '2026-10-12T10:00:00.000Z',
  } as GraphEdge)
}

// The 414 topology: frontend-proxy ──▶ frontend ──▶ recommendation, recommendation
// dead (STALE inbound, 61 erroring calls), and the incidents as the bench
// recorded them: ECONNREFUSED on the caller, none of it on recommendation.
function praxis414(): { g: NeatGraph; incidents: ErrorEvent[] } {
  const g = newGraph()
  for (const s of ['frontend-proxy', 'frontend', 'recommendation']) svc(g, s)
  calls(g, 'service:frontend-proxy', 'service:frontend', { count: 302, err: 61 })
  calls(g, 'service:frontend', 'service:recommendation', { count: 61, err: 61, stale: true })
  const at = '2026-10-12T10:05:00.000Z'
  const incidents: ErrorEvent[] = [
    {
      id: 'inc-frontend',
      timestamp: at,
      service: 'frontend',
      affectedNode: 'service:frontend',
      errorType: 'UNAVAILABLE',
      errorMessage: 'gRPC 14 UNAVAILABLE: connect ECONNREFUSED 10.244.0.31:8080',
    } as ErrorEvent,
    {
      id: 'inc-rec-deadline',
      timestamp: at,
      service: 'recommendation',
      affectedNode: 'service:recommendation',
      errorType: '_MultiThreadedRendezvous',
      errorMessage: 'DEADLINE_EXCEEDED',
    } as ErrorEvent,
    {
      id: 'k8s:otel-demo:recommendation:no-ready-replicas',
      timestamp: at,
      service: 'recommendation',
      affectedNode: 'service:recommendation',
      errorType: 'K8sDeploymentFault',
      errorMessage: 'Deployment recommendation has no ready replicas (desired 1, ready 0)',
    } as ErrorEvent,
    {
      id: 'k8s:otel-demo:recommendation:crash-loop',
      timestamp: at,
      service: 'recommendation',
      affectedNode: 'service:recommendation',
      errorType: 'K8sDeploymentFault',
      errorMessage:
        'Deployment recommendation is crashlooping (restarts: 35); last terminated: Error (exit 1)',
    } as ErrorEvent,
  ]
  return { g, incidents }
}

function crashLoop(g: NeatGraph, over: { exitCode?: number; terminatedReason?: string } = {}): void {
  mergeObservedDeployContext(
    g,
    'service:recommendation',
    'k8s:otel-demo:recommendation:crash-loop',
    '2026-10-12T10:05:00.000Z',
    {
      fault: 'crash-loop',
      waitingReason: 'CrashLoopBackOff',
      restartCount: 35,
      terminatedReason: over.terminatedReason ?? 'Error',
      exitCode: over.exitCode ?? 1,
      containerEnv: ['NEO4J_PRODUCT_DATABASE_ENDPOINT=master-neo4j-productdb:7979'],
    },
  )
}

describe('getRootCause — a seed with its own deploy fault is not a load victim (#1400)', () => {
  it('PRAXIS 414 seeded on the symptom entry: names recommendation, not frontend-proxy', () => {
    const { g, incidents } = praxis414()
    crashLoop(g)
    const res = getRootCause(g, 'service:frontend', undefined, incidents, { now: NOW })!
    expect(res.rootCauseNode).toBe('service:recommendation')
    const proxy = res.candidates?.find((c) => c.node === 'service:frontend-proxy')
    expect(proxy?.classification).not.toBe('primary-failure')
    expect(res.fixRecommendation ?? '').not.toMatch(/throttle|overload/i)
    const top = res.candidates![0]!
    expect(top.classification).toBe('primary-failure')
    expect(top.provenance).toBe(Provenance.OBSERVED)
    expect(top.reason).toMatch(/its own deploy is failing — crash-loop \(CrashLoopBackOff, restarts 35, last exit 1, Error\)/)
    expect(res.traversalPath).toEqual(['service:frontend', 'service:recommendation'])
  })

  it('PRAXIS 414 seeded on recommendation itself: keeps it', () => {
    const { g, incidents } = praxis414()
    crashLoop(g)
    const res = getRootCause(g, 'service:recommendation', undefined, incidents, { now: NOW })!
    expect(res.rootCauseNode).toBe('service:recommendation')
  })

  it('without the deploy context the same graph still reads as a load victim', () => {
    const { g, incidents } = praxis414()
    const res = getRootCause(g, 'service:frontend', undefined, incidents, { now: NOW })!
    // The victim gate fires. frontend-proxy has no observed caller and its errors are
    // on its own calls, so it is a client: never the origin (ADR-264).
    expect(res.rootCauseReason).toContain('No service drives this load: it comes from a client, frontend-proxy')
    expect(res.candidates?.find((c) => c.node === 'service:recommendation')?.classification).toBe('symptom-only')
  })

  it('a process killed by a signal (exit 137) is left to the victim gate', () => {
    // Out of memory under load kills the container from outside; the load can be
    // the cause, so the deploy context does not keep the seed.
    const { g, incidents } = praxis414()
    crashLoop(g, { exitCode: 137, terminatedReason: 'OOMKilled' })
    const res = getRootCause(g, 'service:frontend', undefined, incidents, { now: NOW })!
    // The victim gate fires. frontend-proxy has no observed caller and its errors are
    // on its own calls, so it is a client: never the origin (ADR-264).
    expect(res.rootCauseReason).toContain('No service drives this load: it comes from a client, frontend-proxy')
    expect(res.candidates?.find((c) => c.node === 'service:recommendation')?.classification).toBe('symptom-only')
  })

  it('a deploy context whose incident is no longer on record does not count', () => {
    const { g, incidents } = praxis414()
    crashLoop(g)
    const live = incidents.filter((ev) => !ev.id.endsWith(':crash-loop'))
    const res = getRootCause(g, 'service:frontend', undefined, live, { now: NOW })!
    // The victim gate fires. frontend-proxy has no observed caller and its errors are
    // on its own calls, so it is a client: never the origin (ADR-264).
    expect(res.rootCauseReason).toContain('No service drives this load: it comes from a client, frontend-proxy')
    expect(res.candidates?.find((c) => c.node === 'service:recommendation')?.classification).toBe('symptom-only')
  })
})
