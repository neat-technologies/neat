import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  dependencyId,
  dependencySymbolId,
  isDependencyNodeId,
  isDependencySymbolId,
  parseDependencySymbolId,
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
import { incidentLead } from '../src/incident-lead.js'
import { composeNodeCard } from '../src/goodybag.js'
import type { ErrorEvent } from '@neat.is/types'
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
  // Dependency code (dependency-inventory.md §5): symbols owned by the
  // DependencyNode, and a call between two of them.
  for (const [name, version] of pkgs) {
    const owner = dependencyId('npm', name, version)
    const syms = ['index.js#main', 'lib/util.js#helper'].map((s) => {
      const [rel, q] = s.split('#') as [string, string]
      const id = dependencySymbolId('npm', name, version, rel, q)
      graph.addNode(id, {
        id,
        type: NodeType.SymbolNode,
        kind: 'function',
        qualname: q,
        span: { startLine: 1, endLine: 3 },
        service: owner,
        relPath: rel,
        discoveredVia: 'static',
      } as GraphNode)
      const c = `${EdgeType.CONTAINS}:${owner}->${id}`
      graph.addEdgeWithKey(c, owner, id, {
        id: c,
        source: owner,
        target: id,
        type: EdgeType.CONTAINS,
        provenance: Provenance.EXTRACTED,
        confidence: 1,
        evidence: { file: rel, line: 1 },
      } as GraphEdge)
      added += 2
      return id
    })
    const call = `${EdgeType.CALLS}:${syms[0]}->${syms[1]}`
    graph.addEdgeWithKey(call, syms[0]!, syms[1]!, {
      id: call,
      source: syms[0]!,
      target: syms[1]!,
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
      confidence: 1,
      evidence: { file: 'index.js', line: 2 },
    } as GraphEdge)
    added++
  }
  // First-party code calling into a package's export (dependency-inventory.md §5),
  // from every first-party symbol and file.
  const exported = dependencySymbolId('npm', 'express', '4.18.2', 'index.js', 'main')
  graph.forEachNode((id, attrs) => {
    if (attrs.type !== NodeType.SymbolNode && attrs.type !== NodeType.FileNode) return
    if (isDependencyNodeId(id)) return
    const edgeId = `${EdgeType.CALLS}:${id}->${exported}`
    graph.addEdgeWithKey(edgeId, id, exported, {
      id: edgeId,
      source: id,
      target: exported,
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
      confidence: 1,
      evidence: { file: 'x.ts', line: 1, specifier: 'express' },
    } as GraphEdge)
    added++
  })
  // First-party files importing a package (dependency-inventory.md §4).
  const express = dependencyId('npm', 'express', '4.18.2')
  graph.forEachNode((id, attrs) => {
    if (attrs.type !== NodeType.FileNode) return
    const edgeId = `${EdgeType.IMPORTS}:${id}->${express}`
    graph.addEdgeWithKey(edgeId, id, express, {
      id: edgeId,
      source: id,
      target: express,
      type: EdgeType.IMPORTS,
      provenance: Provenance.EXTRACTED,
      confidence: 1,
      evidence: { file: 'x.ts', line: 1, specifier: 'express', bindings: ['express'] },
    } as GraphEdge)
    added++
  })
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
  // The incident path (ADR-221, ADR-271): one recent incident on every
  // first-party file, so the files are the victims and the lead walks their
  // declared dependencies for a quiet upstream cause; then the composed card for
  // each node.
  const incidents = nodes.filter((n) => n.startsWith('file:')).map((n, i) => ({
    id: `e${i}`,
    timestamp: new Date(now - (i % 50) * 1000).toISOString(),
    service: n.split(':')[1] ?? n,
    traceId: `t${i}`,
    spanId: `s${i}`,
    errorMessage: 'connection refused',
    affectedNode: n,
  })) as ErrorEvent[]
  out.lead = strip(incidentLead(graph, incidents))
  for (const n of nodes) out[`card:${n}`] = strip(composeNodeCard(graph, n, incidents, []))
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
  })

  it('round-trip a dependency symbol id, and keep it apart from a service named dep', () => {
    for (const [eco, name, v, rel, q, d] of [
      ['npm', 'lodash', '4.17.21', 'template.js', 'template', undefined],
      ['npm', '@scope/pkg', '1.0.0', 'lib/a.js', 'A.run', 2],
      ['PyPI', 'jinja2', '3.1.4', 'jinja2/filters.py', 'do_mark_safe', undefined],
      ['Go', 'github.com/redis/go-redis/v9', '9.5.1', 'commands.go', 'Client.Get', undefined],
    ] as const) {
      const id = dependencySymbolId(eco, name, v, rel, q, d)
      expect(isDependencySymbolId(id)).toBe(true)
      expect(isDependencyNodeId(id)).toBe(true)
      expect(parseDependencySymbolId(id)).toEqual({ ecosystem: eco, name, version: v, relPath: rel, qualname: q, ...(d !== undefined ? { disambiguator: d } : {}) })
    }
    // a first-party service called `dep` has ordinary symbol ids
    expect(isDependencyNodeId('symbol:dep:src/index.ts#main')).toBe(false)
    expect(isDependencyNodeId('file:dep:src/index.ts')).toBe(false)
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
