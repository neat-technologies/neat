import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode, ErrorEvent, NodeContext } from '@neat.is/types'
import { EdgeType, NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { getRootCause, classifyNode } from '../src/traverse.js'

// #1123 — a target that never served: its callers' calls all fail (connection
// refused / UNAVAILABLE) but it produced NO telemetry of its own — no incidents,
// no outbound calls. It's unreachable (a startup failure, crash, unschedulable
// pod), and the cause is NOT in the trace. Naming it a generic primary-failure
// invites an agent to hallucinate a code fault; `unreachable` says "look at the
// deploy, not the code." A node that actually ran leaves a trace (an own incident
// or an outbound call), so zero-own-telemetry is what separates the two.

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
function failingCall(g: NeatGraph, from: string, to: string, err: number, count: number): void {
  const key = `CALLS:OBSERVED:${from}->${to}`
  g.addEdgeWithKey(key, from, to, {
    id: key,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    callCount: count,
    signal: { spanCount: count, errorCount: err },
    lastObserved: '2026-08-30T18:00:00.000Z',
  } as GraphEdge)
}
function incident(over: Partial<ErrorEvent>): ErrorEvent {
  return {
    id: 'e1',
    timestamp: '2026-08-30T18:00:00.000Z',
    service: 'x',
    traceId: 't',
    spanId: 's',
    errorMessage: 'err',
    affectedNode: 'service:x',
    ...over,
  } as ErrorEvent
}
const base: NodeContext = {
  errorsEmittedHere: 0,
  errorsFromCallers: 0,
  callCount: 0,
  outboundVolume: 0,
  stale: false,
}

describe('classifyNode — unreachable (#1123)', () => {
  it('received failing calls, produced nothing of its own → unreachable', () => {
    expect(classifyNode({ ...base, callCount: 10, errorsFromCallers: 10 })).toBe('unreachable')
  })
  it('served-and-failed (it made outbound calls of its own) → not unreachable', () => {
    expect(classifyNode({ ...base, callCount: 10, errorsFromCallers: 10, outboundVolume: 4 })).toBe('symptom-only')
  })
  it('emits its own errors → primary-failure, never unreachable', () => {
    expect(classifyNode({ ...base, callCount: 10, errorsFromCallers: 10, errorsEmittedHere: 1 })).toBe('primary-failure')
  })
  it('too few inbound calls (a one-off) → not unreachable', () => {
    expect(classifyNode({ ...base, callCount: 2, errorsFromCallers: 2 })).toBe('symptom-only')
  })
  it('a minority of inbound erroring (mostly healthy) → not unreachable', () => {
    expect(classifyNode({ ...base, callCount: 10, errorsFromCallers: 2 })).toBe('symptom-only')
  })
})

describe('getRootCause — names the unreachable target (#1123)', () => {
  it('a caller whose calls to a never-served target all fail → target is unreachable, not the caller', () => {
    const g = newGraph()
    svc(g, 'frontend')
    svc(g, 'recommendation')
    // frontend's calls to recommendation all fail; recommendation has NO outbound
    // and NO incidents of its own — it never served.
    failingCall(g, 'service:frontend', 'service:recommendation', 20, 20)
    const incidents = [
      incident({
        service: 'frontend',
        affectedNode: 'service:frontend',
        errorMessage: 'connection refused calling recommendation',
      }),
    ]
    const res = getRootCause(g, 'service:frontend', undefined, incidents)!
    expect(res.rootCauseNode).toBe('service:recommendation')
    expect(res.candidates![0].node).toBe('service:recommendation')
    expect(res.candidates![0].classification).toBe('unreachable')
    expect(res.rootCauseReason.toLowerCase()).toContain('unreachable')
    expect(res.rootCauseReason.toLowerCase()).toContain('deploy')
  })

  it('follows the failing chain to the deepest never-served target (#1123)', () => {
    const g = newGraph()
    svc(g, 'frontend')
    svc(g, 'recommendation')
    svc(g, 'db')
    // frontend→recommendation→db all failing; recommendation relayed (it called db,
    // so it served), but db never served — db is the unreachable culprit.
    failingCall(g, 'service:frontend', 'service:recommendation', 20, 20)
    failingCall(g, 'service:recommendation', 'service:db', 20, 20)
    const res = getRootCause(g, 'service:frontend', undefined, [
      incident({ service: 'frontend', affectedNode: 'service:frontend', errorMessage: 'error calling recommendation' }),
    ])!
    expect(res.rootCauseNode).toBe('service:db')
    expect(res.candidates![0].classification).toBe('unreachable')
  })

  it('no-regression: a target that served (clean outbound + its own error) is primary-failure, not unreachable', () => {
    const g = newGraph()
    svc(g, 'frontend')
    svc(g, 'recommendation')
    svc(g, 'db')
    failingCall(g, 'service:frontend', 'service:recommendation', 20, 20)
    // recommendation ran: its own call to db landed cleanly (healthy outbound), and
    // it threw its own error — a genuine primary-failure, not "never served".
    failingCall(g, 'service:recommendation', 'service:db', 0, 20)
    const res = getRootCause(g, 'service:frontend', undefined, [
      incident({ service: 'frontend', affectedNode: 'service:frontend', errorMessage: 'error calling recommendation' }),
      incident({ service: 'recommendation', affectedNode: 'service:recommendation', errorMessage: 'TypeError in handler', exceptionType: 'TypeError' }),
    ])!
    expect(res.candidates![0].classification).not.toBe('unreachable')
  })
})
