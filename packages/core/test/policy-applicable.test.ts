import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  EdgeType,
  NodeType,
  Provenance,
  type GraphEdge,
  type GraphNode,
  type Policy,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { selectApplicablePolicies } from '../src/policy.js'
import { buildApi } from '../src/api.js'

// A small graph: a service connecting to a database, calling a payments
// service. Enough to exercise every applicable-match shape without touching the
// demo fixture.
function makeGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode('service:checkout', {
    id: 'service:checkout',
    type: NodeType.ServiceNode,
    name: 'checkout',
    language: 'javascript',
    dependencies: { pg: '7.4.0' },
  } as GraphNode)
  g.addNode('service:payments', {
    id: 'service:payments',
    type: NodeType.ServiceNode,
    name: 'payments',
    language: 'javascript',
  } as GraphNode)
  g.addNode('database:orders-db', {
    id: 'database:orders-db',
    type: NodeType.DatabaseNode,
    name: 'orders-db',
    engine: 'postgres',
    engineVersion: '15',
  } as GraphNode)
  g.addEdgeWithKey('CONNECTS_TO:service:checkout->database:orders-db', 'service:checkout', 'database:orders-db', {
    id: 'CONNECTS_TO:service:checkout->database:orders-db',
    source: 'service:checkout',
    target: 'database:orders-db',
    type: EdgeType.CONNECTS_TO,
    provenance: Provenance.EXTRACTED,
  } as GraphEdge)
  g.addEdgeWithKey('CALLS:service:checkout->service:payments', 'service:checkout', 'service:payments', {
    id: 'CALLS:service:checkout->service:payments',
    source: 'service:checkout',
    target: 'service:payments',
    type: EdgeType.CALLS,
    provenance: Provenance.EXTRACTED,
  } as GraphEdge)
  return g
}

const structuralPolicy: Policy = {
  id: 'service-needs-db',
  name: 'services must reach a database',
  severity: 'warning',
  rule: {
    type: 'structural',
    fromNodeType: NodeType.ServiceNode,
    edgeType: EdgeType.CONNECTS_TO,
    toNodeType: NodeType.DatabaseNode,
  },
}

const ownershipPolicy: Policy = {
  id: 'service-owner',
  name: 'services must declare an owner',
  // critical → resolves to onViolation 'block' for the post-launch gate. The
  // soft guardrail still only surfaces it; it never blocks.
  severity: 'critical',
  rule: { type: 'ownership', nodeType: NodeType.ServiceNode, field: 'owner' },
}

const provenancePolicy: Policy = {
  id: 'payments-observed',
  name: 'calls into payments must be observed',
  severity: 'error',
  rule: {
    type: 'provenance',
    edgeType: EdgeType.CALLS,
    targetNodeId: 'service:payments',
    required: Provenance.OBSERVED,
  },
}

const compatibilityPolicy: Policy = {
  id: 'driver-compat',
  name: 'driver/engine compatibility',
  severity: 'warning',
  rule: { type: 'compatibility', kind: 'driver-engine' },
}

const blastRadiusPolicy: Policy = {
  id: 'checkout-fanout',
  name: 'checkout services must not fan out too far',
  severity: 'warning',
  rule: { type: 'blast-radius', nodeType: NodeType.ServiceNode, maxAffected: 1 },
}

describe('selectApplicablePolicies (soft guardrail — ADR-108)', () => {
  it('surfaces a policy whose subject is the node type (direct subject match)', () => {
    const g = makeGraph()
    const applicable = selectApplicablePolicies(g, [ownershipPolicy], 'service:checkout')
    expect(applicable).toHaveLength(1)
    expect(applicable[0]!.policyId).toBe('service-owner')
    expect(applicable[0]!.match).toBe('subject')
    expect(applicable[0]!.reason).toMatch(/owner/)
  })

  it('surfaces a structural policy on its from-node and its to-node (subject + region)', () => {
    const g = makeGraph()
    const onService = selectApplicablePolicies(g, [structuralPolicy], 'service:checkout')
    expect(onService.map((p) => p.match)).toEqual(['subject'])

    // The database is one hop inside the rule's region — editing it can flip
    // whether a sibling service satisfies the rule, so it surfaces too.
    const onDb = selectApplicablePolicies(g, [structuralPolicy], 'database:orders-db')
    expect(onDb).toHaveLength(1)
    expect(onDb[0]!.match).toBe('region')
  })

  it('surfaces a provenance policy on its named target (subject) and on a node sitting on the governed edge (region)', () => {
    const g = makeGraph()
    const onTarget = selectApplicablePolicies(g, [provenancePolicy], 'service:payments')
    expect(onTarget).toHaveLength(1)
    expect(onTarget[0]!.match).toBe('subject')

    // checkout isn't the named target, but it sits on the CALLS edge into
    // payments — one hop, region match, no traversal.
    const onCaller = selectApplicablePolicies(g, [provenancePolicy], 'service:checkout')
    expect(onCaller).toHaveLength(1)
    expect(onCaller[0]!.match).toBe('region')
  })

  it('surfaces a compatibility policy on a service (subject) and on a connected database (region)', () => {
    const g = makeGraph()
    const onService = selectApplicablePolicies(g, [compatibilityPolicy], 'service:checkout')
    expect(onService).toHaveLength(1)
    expect(onService[0]!.match).toBe('subject')

    const onDb = selectApplicablePolicies(g, [compatibilityPolicy], 'database:orders-db')
    expect(onDb).toHaveLength(1)
    expect(onDb[0]!.match).toBe('region')
  })

  it('surfaces a blast-radius policy downstream — on a node inside the subject\'s blast radius, not only on the subject', () => {
    const g = makeGraph()
    // checkout (a ServiceNode) is the subject.
    const onSubject = selectApplicablePolicies(g, [blastRadiusPolicy], 'service:checkout')
    expect(onSubject).toHaveLength(1)
    expect(onSubject[0]!.match).toBe('subject')

    // orders-db sits downstream of checkout (checkout CONNECTS_TO orders-db).
    // The agent editing it is exactly who the fan-out cap should warn, so the
    // rule surfaces here as a region match — the case the one-hop MVP missed.
    const onDownstream = selectApplicablePolicies(g, [blastRadiusPolicy], 'database:orders-db')
    expect(onDownstream).toHaveLength(1)
    expect(onDownstream[0]!.match).toBe('region')
    expect(onDownstream[0]!.reason).toMatch(/service:checkout/)

    // A node that is a ServiceNode in its own right matches as a subject first —
    // payments is the rule's subject, so it never reads as merely a region.
    const onPayments = selectApplicablePolicies(g, [blastRadiusPolicy], 'service:payments')
    expect(onPayments).toHaveLength(1)
    expect(onPayments[0]!.match).toBe('subject')
  })

  it('respects the rule\'s declared depth when surfacing downstream', () => {
    const g = makeGraph()
    // A second database two hops from the only service: checkout → orders-db
    // (CONNECTS_TO, depth 1) → warehouse (DEPENDS_ON, depth 2).
    g.addNode('database:warehouse', {
      id: 'database:warehouse',
      type: NodeType.DatabaseNode,
      name: 'warehouse',
      engine: 'postgres',
      engineVersion: '15',
    } as GraphNode)
    g.addEdgeWithKey('DEPENDS_ON:database:orders-db->database:warehouse', 'database:orders-db', 'database:warehouse', {
      id: 'DEPENDS_ON:database:orders-db->database:warehouse',
      source: 'database:orders-db',
      target: 'database:warehouse',
      type: EdgeType.DEPENDS_ON,
      provenance: Provenance.EXTRACTED,
    } as GraphEdge)
    const depthOne: Policy = {
      id: 'fanout-shallow',
      name: 'shallow fan-out cap',
      severity: 'info',
      rule: { type: 'blast-radius', nodeType: NodeType.ServiceNode, maxAffected: 1, depth: 1 },
    }
    // orders-db is one hop from checkout — within a depth-1 walk, so it surfaces.
    const onDb = selectApplicablePolicies(g, [depthOne], 'database:orders-db')
    expect(onDb).toHaveLength(1)
    expect(onDb[0]!.match).toBe('region')

    // warehouse is two hops from checkout (the only service); a depth-1 rule
    // must not reach it, so nothing surfaces.
    const onWarehouse = selectApplicablePolicies(g, [depthOne], 'database:warehouse')
    expect(onWarehouse).toEqual([])
  })

  it('does not match policies whose subject/region the node is outside of (no full traversal)', () => {
    const g = makeGraph()
    // payments has no outbound CONNECTS_TO of its own, so the structural rule's
    // from-side doesn't fire on it as a subject — only as nothing. It IS a
    // ServiceNode though, so structural fromNodeType matches. To prove the
    // no-traversal boundary, use a database-only ownership rule that payments
    // can't be a subject of.
    const dbOwnership: Policy = {
      id: 'db-owner',
      name: 'databases must declare an owner',
      severity: 'info',
      rule: { type: 'ownership', nodeType: NodeType.DatabaseNode, field: 'owner' },
    }
    const onService = selectApplicablePolicies(g, [dbOwnership], 'service:payments')
    expect(onService).toEqual([])
  })

  it('returns nothing for a node that is not in the graph', () => {
    const g = makeGraph()
    expect(selectApplicablePolicies(g, [ownershipPolicy], 'service:ghost')).toEqual([])
  })

  it('informs, never blocks — it returns plain context with no verdict, even for a block-action policy', () => {
    const g = makeGraph()
    const applicable = selectApplicablePolicies(g, [ownershipPolicy], 'service:checkout')
    // The policy resolves to onViolation 'block' (critical severity), but the
    // applicable record carries no allowed/denied flag and no blocking
    // semantics — it's awareness, surfaced as context.
    const record = applicable[0]!
    expect(record.onViolation).toBe('block')
    expect(record).not.toHaveProperty('allowed')
    expect(record).not.toHaveProperty('blocked')
    // The record is plain context — nothing but the policy's identity, the
    // match reason, and the (advisory) resolved action. No verdict fields.
    for (const key of Object.keys(record)) {
      expect([
        'description',
        'match',
        'onViolation',
        'policyId',
        'policyName',
        'reason',
        'ruleType',
        'severity',
      ]).toContain(key)
    }
  })
})

describe('GET /policies/applicable (REST soft-guardrail read path)', () => {
  let app: FastifyInstance
  let scanDir: string

  beforeEach(async () => {
    scanDir = mkdtempSync(path.join(tmpdir(), 'policy-applicable-'))
    writeFileSync(
      path.join(scanDir, 'policy.json'),
      JSON.stringify({ version: 1, policies: [ownershipPolicy, provenancePolicy] }),
      'utf8',
    )
    app = await buildApi({ graph: makeGraph(), scanPath: scanDir })
  })

  afterEach(async () => {
    await app.close()
    rmSync(scanDir, { recursive: true, force: true })
  })

  it('returns the applicable policies for a node', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/policies/applicable?node=service:checkout',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.node).toBe('service:checkout')
    const ids = body.applicable.map((p: { policyId: string }) => p.policyId).sort()
    // checkout is a ServiceNode (ownership subject) and sits on the CALLS edge
    // into payments (provenance region).
    expect(ids).toEqual(['payments-observed', 'service-owner'])
    // No verdict field anywhere on the response — it informs, it doesn't gate.
    expect(body).not.toHaveProperty('allowed')
  })

  it('returns an empty applicable set for a node no policy governs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/policies/applicable?node=database:orders-db',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().applicable).toEqual([])
  })

  it('400s when the node query param is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/policies/applicable' })
    expect(res.statusCode).toBe(400)
  })

  it('dual-mounts under /projects/:project', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/default/policies/applicable?node=service:checkout',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().node).toBe('service:checkout')
  })
})
