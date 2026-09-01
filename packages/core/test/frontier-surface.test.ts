import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import { EdgeType, NodeType, Provenance, frontierEdgeId, observedEdgeId } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { saveGraphToDisk, loadGraphFromDisk } from '../src/persist.js'
import { getTransitiveDependencies, getBlastRadius } from '../src/traverse.js'

// ADR-226 — a FRONTIER edge is a real, persisted *surface*: a placeholder for an
// OBSERVED edge NEAT cannot yet see (a hop it reached toward, whose far end hung).
// It round-trips through persist like any edge, but it is NEVER part of the settled
// graph: it stays out of PROV_RANK and is skipped by every settled traversal (Rule
// 3, edge level), so a proposal never contests a settled edge. This is PR 1 of the
// FRONTIER surface primitive — the substrate the hang sensor (PR 3) will write to.

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
function frontierEdge(g: NeatGraph, from: string, to: string): string {
  const key = frontierEdgeId(from, to, EdgeType.CALLS)
  g.addEdgeWithKey(key, from, to, {
    id: key,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: Provenance.FRONTIER,
  } as GraphEdge)
  return key
}
function observedEdge(g: NeatGraph, from: string, to: string): string {
  const key = observedEdgeId(from, to, EdgeType.CALLS)
  g.addEdgeWithKey(key, from, to, {
    id: key,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    callCount: 10,
    signal: { spanCount: 10, errorCount: 0 },
    lastObserved: '2026-08-29T18:00:00.000Z',
  } as GraphEdge)
  return key
}

describe('FRONTIER surface — persist round-trip (ADR-226)', () => {
  const tmpFiles: string[] = []
  afterEach(async () => {
    for (const f of tmpFiles.splice(0)) await fs.rm(f, { force: true })
  })

  it('a FRONTIER edge survives save → load with its provenance and id intact', async () => {
    const g = newGraph()
    svc(g, 'frontend')
    svc(g, 'recommendation')
    const key = frontierEdge(g, 'service:frontend', 'service:recommendation')

    const outPath = path.join(tmpdir(), `neat-frontier-${Date.now()}.json`)
    tmpFiles.push(outPath)
    await saveGraphToDisk(g, outPath)

    const loaded = newGraph()
    await loadGraphFromDisk(loaded, outPath)

    expect(loaded.hasEdge(key)).toBe(true)
    const e = loaded.getEdgeAttributes(key) as GraphEdge
    expect(e.provenance).toBe(Provenance.FRONTIER)
    expect(e.id).toBe('CALLS:FRONTIER:service:frontend->service:recommendation')
    expect(e.source).toBe('service:frontend')
    expect(e.target).toBe('service:recommendation')
  })
})

describe('FRONTIER surface — excluded from settled traversal (ADR-226, Rule 3 edge level)', () => {
  it('getTransitiveDependencies reports the OBSERVED callee but never the FRONTIER surface', () => {
    const g = newGraph()
    svc(g, 'a')
    svc(g, 'observed-dep')
    svc(g, 'frontier-dep')
    observedEdge(g, 'service:a', 'service:observed-dep')
    frontierEdge(g, 'service:a', 'service:frontier-dep')

    const deps = getTransitiveDependencies(g, 'service:a')
    const ids = deps.dependencies.map((d) => d.nodeId)
    expect(ids).toContain('service:observed-dep')
    expect(ids).not.toContain('service:frontier-dep')
  })

  it('getBlastRadius does not traverse a FRONTIER edge into the origin', () => {
    const g = newGraph()
    svc(g, 'caller')
    svc(g, 'frontier-target')
    svc(g, 'observed-target')
    // caller reaches both, but only the OBSERVED edge is settled topology.
    frontierEdge(g, 'service:caller', 'service:frontier-target')
    observedEdge(g, 'service:caller', 'service:observed-target')

    // The OBSERVED target's failure blasts back to its caller.
    const observed = getBlastRadius(g, 'service:observed-target')
    expect(observed.affectedNodes.map((n) => n.nodeId)).toContain('service:caller')

    // The FRONTIER target is a staged surface: its inbound edge is not traversed,
    // so the caller is NOT in its blast radius.
    const frontier = getBlastRadius(g, 'service:frontier-target')
    expect(frontier.affectedNodes.map((n) => n.nodeId)).not.toContain('service:caller')
  })
})
