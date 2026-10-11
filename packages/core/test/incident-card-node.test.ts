import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  IncidentCardSchema,
  NodeType,
  Provenance,
  type ErrorEvent,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import { buildApi } from '../src/api.js'
import { NO_INCIDENT_REASON, buildIncidentCard, composeNodeCard } from '../src/goodybag.js'
import { mergeObservedDeployContext } from '../src/ingest.js'
import type { NeatGraph } from '../src/graph.js'

// The card composed for a node with no recorded incident (ADR-244): the same
// shape as an incident's card, built from the graph alone. The fields only an
// incident supplies are null with one reason; nothing about a failure is invented.

const SVC = 'service:cart'
const DB = 'database:cart-db'

function graph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode(SVC, { id: SVC, type: NodeType.ServiceNode, name: 'cart', language: 'csharp' } as unknown as GraphNode)
  g.addNode(DB, { id: DB, type: NodeType.DatabaseNode, name: 'cart-db', engine: 'redis', engineVersion: '7' } as unknown as GraphNode)
  const edge = {
    id: `${SVC}->${DB}:CONNECTS_TO`,
    source: SVC,
    target: DB,
    type: EdgeType.CONNECTS_TO,
    provenance: Provenance.EXTRACTED,
  } as GraphEdge
  g.addEdgeWithKey(edge.id, SVC, DB, edge)
  return g
}

function incident(over: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    id: 't1:s1',
    timestamp: '2026-10-11T10:00:00.000Z',
    service: 'cart',
    traceId: 't1',
    spanId: 's1',
    errorMessage: 'RedisConnectionException',
    exceptionType: 'RedisConnectionException',
    affectedNode: SVC,
    ...over,
  }
}

describe('composeNodeCard — a node with no recorded incident', () => {
  it('nulls the incident-only fields with one reason and composes the rest from the graph', () => {
    const card = composeNodeCard(graph(), SVC, [], [])
    expect(IncidentCardSchema.safeParse(card).success).toBe(true)
    expect(card.id).toBeNull()
    expect(card.at).toBeNull()
    expect(card.incidentKind).toBeNull()
    expect(card.message).toBeNull()
    expect(card.noIncident).toEqual({ reason: NO_INCIDENT_REASON })
    expect(card.affectedNode).toBe(SVC)
    expect(card.service).toBe('cart')
    // Nothing the graph didn't record: no event-only fields at all.
    for (const k of ['exceptionType', 'httpStatusCode', 'count', 'window', 'traceId', 'spanId']) {
      expect(card).not.toHaveProperty(k)
    }
    expect(card.headline).toMatch(/^SERVICE cart has no recorded incident/)
  })

  it('grades the incident-only factors null with a reason instead of guessing them', () => {
    const card = composeNodeCard(graph(), SVC, [], [])
    const f = card.grade!.factors
    expect(f.kind.value).toBeNull()
    expect(f.kind.reason).toBe('no incident on the card')
    expect(f.recur.value).toBeNull()
    expect(f.recur.reason).toBe('no incident on the card')
    expect(f.div.value).not.toBeNull()
  })

  it('does not look fix-ready when nothing resolves a locus', () => {
    const card = composeNodeCard(graph(), SVC, [], [])
    expect(card.locus).toBeNull()
    expect(card.grade!.gates.locusResolves.passed).toBe(false)
    expect(card.grade!.band).toBe('out')
  })

  it('leaves service null for a node no service owns', () => {
    const card = composeNodeCard(graph(), DB, [], [])
    expect(card.service).toBeNull()
    expect(card.headline).toMatch(/^DATABASE cart-db has no recorded incident/)
    // The blast radius is a graph read and composes as for any card: cart depends on it.
    expect(card.blastRadius?.nearest.map((n) => n.node)).toContain(SVC)
  })

  // Both graph modules land on one composed card: the flag grain's divergence
  // (ADR-242) and the workload's deploy context (ADR-243), each read off its node.
  it('carries the flag mismatch and the node\'s deploy context together', () => {
    const g = graph()
    const STORE = 'infra:flag-store:flagd'
    const def = (dv: string) => ({ state: 'ENABLED', defaultVariant: dv, variants: { off: false, on: true } })
    g.addNode(STORE, {
      id: STORE,
      type: NodeType.InfraNode,
      name: 'flagd',
      provider: 'flagd',
      kind: 'flag-store',
      flags: [
        {
          key: 'cartFailure',
          provenances: [Provenance.EXTRACTED, Provenance.OBSERVED],
          declared: def('off'),
          observed: def('on'),
          readers: [{ file: 'file:cart:src/services/CartService.cs', service: SVC, line: 83 }],
        },
      ],
    } as unknown as GraphNode)
    mergeObservedDeployContext(g, SVC, 'k8s:cart:1', '2026-10-11T10:00:00.000Z', {
      fault: 'crash-loop',
      containerEnv: ['VALKEY_ADDR=valkey-cart:6379'],
    })
    const card = composeNodeCard(g, SVC, [], [])
    expect(IncidentCardSchema.safeParse(card).success).toBe(true)
    expect(card.divergence).toContainEqual({
      type: 'flag-mismatch',
      summary: 'flag cartFailure: committed off, running on (read at src/services/CartService.cs:83)',
    })
    expect(card.deployContext).toEqual({ fault: 'crash-loop', containerEnv: ['VALKEY_ADDR=valkey-cart:6379'] })
  })

  it('never marks a card built from an incident', () => {
    const card = buildIncidentCard(graph(), incident(), [incident()], [])
    expect(card).not.toHaveProperty('noIncident')
    expect(card.id).toBe('t1:s1')
    expect(card.incidentKind).toBe('exception')
    expect(card.grade!.factors.kind.value).not.toBeNull()
    expect(card.grade!.factors.recur.value).not.toBeNull()
  })
})

describe('GET /graph/incident-card/:nodeId — composes when the node has no incident', () => {
  let tmpDir: string
  let errorsPath: string
  let app: Awaited<ReturnType<typeof buildApi>>

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-node-card-'))
    errorsPath = path.join(tmpDir, 'errors.ndjson')
    await fs.writeFile(errorsPath, JSON.stringify(incident({ affectedNode: DB, service: 'cart-db' })) + '\n', 'utf8')
    app = await buildApi({ graph: graph(), errorsPath })
  })

  afterEach(async () => {
    await app.close()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns 200 with the node-composed card instead of 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/graph/incident-card/${SVC}` })
    expect(res.statusCode).toBe(200)
    const card = res.json()
    expect(card.noIncident.reason).toBe(NO_INCIDENT_REASON)
    expect(card.id).toBeNull()
  })

  it('still returns the recorded incident when the node has one', async () => {
    const res = await app.inject({ method: 'GET', url: `/graph/incident-card/${DB}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe('t1:s1')
    expect(res.json()).not.toHaveProperty('noIncident')
  })

  it('still 404s an unknown errorId and an unknown node', async () => {
    const missingEvent = await app.inject({ method: 'GET', url: `/graph/incident-card/${SVC}?errorId=nope` })
    expect(missingEvent.statusCode).toBe(404)
    const missingNode = await app.inject({ method: 'GET', url: '/graph/incident-card/service:ghost' })
    expect(missingNode.statusCode).toBe(404)
  })
})
