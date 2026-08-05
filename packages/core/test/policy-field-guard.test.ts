import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  NodeType,
  Provenance,
  type GraphEdge,
  type GraphNode,
  type Policy,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { evaluateAllPolicies } from '../src/policy.js'

// ADR-169 — the `field-guard` policy, evaluated through the same
// `evaluateAllPolicies` path every other rule takes. Firestore is the first
// instance: set A is the collection's client-written columns (`ColumnAttr` whose
// `sdkWrites` includes 'client'), set B is `guardedFields` folded from
// `firestore.rules`. A client-written field absent from B is one violation. The
// `sdkWrites` tag is F1's (ADR-167) declared interface — this file constructs it
// on the fixture the same shape F1 will fold, and the evaluator reads it
// defensively, so a column with no `sdkWrites` never triggers a false positive.

const ctx = { now: () => Date.parse('2026-08-05T12:00:00.000Z') }

const fieldGuardPolicy: Policy = {
  id: 'firestore-field-guard',
  name: 'client-written fields must be guarded by firestore.rules',
  severity: 'error',
  rule: {
    type: 'field-guard',
    nodeType: NodeType.InfraNode,
    nodeKind: 'firestore-collection',
    subjectSet: 'client-written-columns',
    guardSet: 'guardedFields',
  },
}

// A ColumnAttr carrying F1's optional `sdkWrites` dimension. Built through the
// object literal directly (the field lands on `ColumnAttr` with #939) — the graph
// node attrs are cast to GraphNode, so the fixture compiles before F1 merges.
interface Col {
  name: string
  provenances: Provenance[]
  confidence: number
  sdkWrites?: ('client' | 'admin')[]
}

function collectionNode(
  name: string,
  columns: Col[],
  guardedFields?: string[],
): GraphNode {
  return {
    id: `infra:firestore-collection:${name}`,
    type: NodeType.InfraNode,
    name,
    provider: 'self',
    kind: 'firestore-collection',
    columns,
    ...(guardedFields !== undefined ? { guardedFields } : {}),
  } as unknown as GraphNode
}

function graphWith(node: GraphNode): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode((node as { id: string }).id, node)
  return g
}

const col = (name: string, sdkWrites?: ('client' | 'admin')[]): Col => ({
  name,
  provenances: [Provenance.EXTRACTED],
  confidence: 0.9,
  ...(sdkWrites !== undefined ? { sdkWrites } : {}),
})

describe('field-guard policy — client-written fields must be guarded', () => {
  it('flags a client-written field absent from guardedFields', () => {
    const g = graphWith(
      collectionNode(
        'users',
        [col('name', ['client']), col('role', ['client'])],
        ['name'], // 'role' is written by the client SDK but not guarded
      ),
    )
    const violations = evaluateAllPolicies(g, [fieldGuardPolicy], ctx)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.ruleType).toBe('field-guard')
    expect(violations[0]!.subject.nodeId).toBe('infra:firestore-collection:users')
    expect(violations[0]!.message).toContain('role')
    expect(violations[0]!.severity).toBe('error')
    // Deterministic id: policyId + nodeId + field.
    expect(violations[0]!.id).toBe('firestore-field-guard:infra:firestore-collection:users:role')
  })

  it('is silent when every client-written field is guarded', () => {
    const g = graphWith(
      collectionNode('users', [col('name', ['client']), col('email', ['client'])], ['name', 'email']),
    )
    expect(evaluateAllPolicies(g, [fieldGuardPolicy], ctx)).toHaveLength(0)
  })

  it('is silent (indeterminate) when the collection carries no guardedFields', () => {
    // No guardedFields at all — the rules were condition-based / unparseable, so
    // the producer folded nothing. Never a false positive.
    const g = graphWith(collectionNode('sessions', [col('token', ['client'])]))
    expect(evaluateAllPolicies(g, [fieldGuardPolicy], ctx)).toHaveLength(0)
  })

  it('excludes admin-only writes — they bypass security rules', () => {
    const g = graphWith(
      collectionNode(
        'audit',
        [col('actor', ['client']), col('internalflag', ['admin'])],
        ['actor'], // internalFlag is admin-written; not subject to the client guard
      ),
    )
    expect(evaluateAllPolicies(g, [fieldGuardPolicy], ctx)).toHaveLength(0)
  })

  it('is silent when a column carries no sdkWrites tag (defensive read)', () => {
    // Set A is empty when nothing is tagged client-written — the F1-absent case.
    const g = graphWith(collectionNode('legacy', [col('anything'), col('more')], []))
    expect(evaluateAllPolicies(g, [fieldGuardPolicy], ctx)).toHaveLength(0)
  })

  it('flags every unguarded client-written field independently', () => {
    const g = graphWith(
      collectionNode(
        'products',
        [col('title', ['client']), col('price', ['client']), col('sku', ['client'])],
        ['title'],
      ),
    )
    const violations = evaluateAllPolicies(g, [fieldGuardPolicy], ctx)
    expect(violations.map((v) => v.message).join(' ')).toContain('price')
    expect(violations).toHaveLength(2)
  })
})
