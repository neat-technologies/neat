import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  databaseId,
  type DatabaseNode,
  type GraphEdge,
  type GraphNode,
  type ServiceNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { computeDivergences } from '../src/divergences.js'

// A single service<->DB host drift naturally lights up three ways: the
// host-mismatch itself, a missing-extracted on the observed DB node, and a
// missing-observed on the declared DB node. The two missing-* halves are the
// same drift the host-mismatch already names in full, so they collapse into it
// — one divergence per distinct problem (#591).
describe('host-mismatch cross-pass dedup (#591)', () => {
  const DECLARED = 'db.prod.internal'
  const OBSERVED = '127.0.0.1'

  function build(): NeatGraph {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({
      allowSelfLoops: false,
    })
    g.addNode('service:orders', {
      id: 'service:orders',
      type: NodeType.ServiceNode,
      name: 'orders',
      language: 'javascript',
      dbConnectionTarget: `${DECLARED}:5432`,
    } as ServiceNode)
    g.addNode('config:orders:.env', {
      id: 'config:orders:.env',
      type: NodeType.ConfigNode,
      name: '.env',
    } as unknown as GraphNode)

    const declaredDbId = databaseId(DECLARED)
    g.addNode(declaredDbId, {
      id: declaredDbId,
      type: NodeType.DatabaseNode,
      name: DECLARED,
      engine: 'postgresql',
      engineVersion: 'unknown',
      compatibleDrivers: [],
      host: DECLARED,
    } as DatabaseNode)

    const observedDbId = databaseId(OBSERVED)
    g.addNode(observedDbId, {
      id: observedDbId,
      type: NodeType.DatabaseNode,
      name: OBSERVED,
      engine: 'postgresql',
      engineVersion: 'unknown',
      compatibleDrivers: [],
      host: OBSERVED,
      discoveredVia: 'otel',
    } as DatabaseNode)

    // EXTRACTED CONFIGURED_BY so the host-mismatch gate is satisfiable.
    const cfgEdge = `${EdgeType.CONFIGURED_BY}:service:orders->config:orders:.env`
    g.addEdgeWithKey(cfgEdge, 'service:orders', 'config:orders:.env', {
      id: cfgEdge,
      source: 'service:orders',
      target: 'config:orders:.env',
      type: EdgeType.CONFIGURED_BY,
      provenance: Provenance.EXTRACTED,
    })

    // EXTRACTED CONNECTS_TO to the DECLARED db, never observed → missing-observed.
    const declaredEdge = `${EdgeType.CONNECTS_TO}:config:orders:.env->${declaredDbId}`
    g.addEdgeWithKey(declaredEdge, 'config:orders:.env', declaredDbId, {
      id: declaredEdge,
      source: 'config:orders:.env',
      target: declaredDbId,
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.EXTRACTED,
      confidence: 0.85,
    })

    // OBSERVED CONNECTS_TO to the OBSERVED db, never extracted → both
    // missing-extracted and (against the declared target) host-mismatch.
    const observedEdge = `${EdgeType.CONNECTS_TO}:OBSERVED:service:orders->${observedDbId}`
    g.addEdgeWithKey(observedEdge, 'service:orders', observedDbId, {
      id: observedEdge,
      source: 'service:orders',
      target: observedDbId,
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.OBSERVED,
    })
    return g
  }

  it('collapses the two missing-* halves into the fired host-mismatch', () => {
    const result = computeDivergences(build())

    const hostMismatch = result.divergences.filter((d) => d.type === 'host-mismatch')
    expect(hostMismatch).toHaveLength(1)

    // The redundant halves are gone: no missing-extracted on the observed DB,
    // no missing-observed on the declared DB.
    const missingExtracted = result.divergences.filter(
      (d) => d.type === 'missing-extracted' && d.target === databaseId(OBSERVED),
    )
    expect(missingExtracted).toHaveLength(0)

    const missingObserved = result.divergences.filter(
      (d) => d.type === 'missing-observed' && d.target === databaseId(DECLARED),
    )
    expect(missingObserved).toHaveLength(0)

    // One divergence total for this one drift.
    expect(result.totalAffected).toBe(1)
  })

  it('leaves an unrelated missing-observed untouched', () => {
    const g = build()
    // A second declared DB with no drift and no observed twin: a genuine
    // missing-observed that must survive.
    const otherDbId = databaseId('reports-db.internal')
    g.addNode(otherDbId, {
      id: otherDbId,
      type: NodeType.DatabaseNode,
      name: 'reports-db.internal',
      engine: 'postgresql',
      engineVersion: 'unknown',
      compatibleDrivers: [],
      host: 'reports-db.internal',
    } as DatabaseNode)
    const otherEdge = `${EdgeType.CONNECTS_TO}:config:orders:.env->${otherDbId}`
    g.addEdgeWithKey(otherEdge, 'config:orders:.env', otherDbId, {
      id: otherEdge,
      source: 'config:orders:.env',
      target: otherDbId,
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.EXTRACTED,
      confidence: 0.85,
    })

    const result = computeDivergences(g)
    const survivor = result.divergences.find(
      (d) => d.type === 'missing-observed' && d.target === otherDbId,
    )
    expect(survivor).toBeDefined()
  })
})
