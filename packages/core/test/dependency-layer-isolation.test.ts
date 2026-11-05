import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  dependencyId,
  isDependencyNodeId,
  parseDependencyId,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import {
  expandNode,
  getBlastRadius,
  getObservedDependencies,
  getRootCause,
  getTransitiveDependencies,
  nodeContext,
  relate,
} from '../src/traverse.js'
import { computeDivergences } from '../src/divergences.js'
import { evaluateAllPolicies } from '../src/policy.js'
import type { Policy } from '@neat.is/types'

const POLICIES = [
  { id: 'p-prov', name: 'deps observed', severity: 'warning', rule: { type: 'provenance', edgeType: 'DEPENDS_ON', required: 'OBSERVED' } },
  { id: 'p-own', name: 'owned', severity: 'info', rule: { type: 'ownership', nodeType: 'ServiceNode', field: 'owner' } },
  { id: 'p-blast', name: 'blast', severity: 'warning', rule: { type: 'blast-radius', nodeType: 'ServiceNode', maxAffected: 1 } },
  { id: 'p-struct', name: 'no svc→svc', severity: 'error', rule: { type: 'structural', fromNodeType: 'ServiceNode', edgeType: 'DEPENDS_ON', toNodeType: 'ServiceNode' } },
] as unknown as Policy[]

// ADR-274: dependency nodes sit outside every first-party query. The test builds
// the demo graph, records what each first-party query answers for every node, adds
// a dependency layer (nodes plus service→dep DEPENDS_ON edges), and asserts every
// answer is unchanged.

const DEMO = path.resolve(__dirname, '../../../demo')

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
}

function addDependencyLayer(graph: NeatGraph): number {
  let added = 0
  const services: string[] = []
  graph.forEachNode((id, attrs) => {
    if (attrs.type === NodeType.ServiceNode) services.push(id)
  })
  const pkgs: Array<[string, string]> = [
    ['express', '4.18.2'],
    ['lodash', '4.17.15'],
    ['@opentelemetry/sdk-node', '0.52.1'],
    ['qs', '6.11.0'],
  ]
  for (const [name, version] of pkgs) {
    const id = dependencyId('npm', name, version)
    graph.addNode(id, {
      id,
      type: NodeType.DependencyNode,
      name,
      ecosystem: 'npm',
      version,
      purl: `pkg:npm/${name}@${version}`,
    } as GraphNode)
    added++
    for (const svc of services) {
      const edgeId = `${EdgeType.DEPENDS_ON}:${svc}->${id}`
      graph.addEdgeWithKey(edgeId, svc, id, {
        id: edgeId,
        source: svc,
        target: id,
        type: EdgeType.DEPENDS_ON,
        provenance: Provenance.EXTRACTED,
        confidence: 1,
        evidence: { file: 'package-lock.json' },
        dependency: { scope: name === 'qs' ? 'transitive' : 'direct', dev: false, introducedBy: name === 'qs' ? ['express'] : [] },
      } as GraphEdge)
    }
  }
  return added
}

function strip(value: unknown): unknown {
  // computedAt and similar wall-clock fields differ between runs.
  return JSON.parse(JSON.stringify(value, (k, v) => (k === 'computedAt' ? undefined : v)))
}

function answers(graph: NeatGraph, nodes: string[], now: number) {
  const out: Record<string, unknown> = {}
  for (const n of nodes) {
    out[`blast:${n}`] = strip(getBlastRadius(graph, n))
    out[`deps:${n}`] = strip(getTransitiveDependencies(graph, n))
    out[`observed:${n}`] = strip(getObservedDependencies(graph, n))
    out[`root:${n}`] = strip(getRootCause(graph, n, undefined, [], { now }))
    out[`ctx:${n}`] = strip(nodeContext(graph, n, [], now))
    out[`up:${n}`] = strip(expandNode(graph, n, 'up', [], now))
    out[`down:${n}`] = strip(expandNode(graph, n, 'down', [], now))
  }
  for (const a of nodes) for (const b of nodes) if (a !== b) out[`relate:${a}|${b}`] = strip(relate(graph, a, b))
  out.divergences = strip(computeDivergences(graph, {}))
  out.policies = strip(evaluateAllPolicies(graph, POLICIES, { now: () => now }))
  return out
}

describe('dependency ids', () => {
  it('round-trip, including scoped names', () => {
    for (const [eco, name, v] of [
      ['npm', 'lodash', '4.17.21'],
      ['npm', '@opentelemetry/sdk-node', '0.52.1'],
      ['PyPI', 'jinja2', '3.1.4'],
      ['Go', 'golang.org/x/net', '0.0.0-20220906165146-f3363e06e74c'],
    ]) {
      const id = dependencyId(eco, name, v)
      expect(isDependencyNodeId(id)).toBe(true)
      expect(parseDependencyId(id)).toEqual({ ecosystem: eco, name, version: v })
    }
    expect(parseDependencyId('service:dep')).toBeNull()
    expect(isDependencyNodeId('service:api')).toBe(false)
  })
})

describe('the dependency layer changes no first-party query (ADR-274)', () => {
  it('every traversal and the divergence query answer the same with and without it', async () => {
    const graph = newGraph()
    await extractFromDirectory(graph, DEMO, { announce: false })
    const firstParty = graph.nodes()
    expect(firstParty.length).toBeGreaterThan(0)
    const now = Date.parse('2026-11-05T12:00:00Z')

    const before = answers(graph, firstParty, now)
    expect(addDependencyLayer(graph)).toBeGreaterThan(0)
    const after = answers(graph, firstParty, now)

    const changed = Object.keys(before).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    )
    expect(changed).toEqual([])
  })
})
