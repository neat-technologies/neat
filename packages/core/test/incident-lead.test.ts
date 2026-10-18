import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  IncidentLeadSchema,
  NodeType,
  Provenance,
  type ErrorEvent,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { incidentLead, trafficSourceCallees } from '../src/incident-lead.js'
import { askGraph } from '../src/ask.js'
import { buildApi } from '../src/api.js'

// ADR-264 — #1479 and #1483, the structural and the temporal half of one ranking.
// On astronomy-shop the load generator fails its flagd flag evaluations from the
// moment the system comes up (80 of 80 calls to flagd:8016 time out or fail to
// resolve on the box's live daemon, 2026-10-18), and gets the odd 500 back from
// frontend-proxy. It piled up thousands of incidents on the SREGym-Lite run and led
// 14 of 35 cards; on missing_stale_cache_fallback it led `ask` and the card named
// flagd. Neither is the fault. The messages below are the ones those runs recorded.

const T0 = Date.parse('2026-10-17T18:00:00.000Z')
const at = (min: number, sec = 0): string => new Date(T0 + min * 60_000 + sec * 1000).toISOString()

const FLAGD_TIMEOUT =
  "HTTPConnectionPool(host='flagd', port=8016): Max retries exceeded with url: /ofrep/v1/evaluate/flags/loadGeneratorFloodHomepage (Caused by ConnectTimeoutError(<HTTPConnection(host='flagd', port=8016) at 0x70a5b9d064b0>, 'Connection to flagd timed out. (connect timeout=5.0)'))"
const DEADLINE =
  '<_InactiveRpcError of RPC that terminated with:\n\tstatus = StatusCode.DEADLINE_EXCEEDED\n\tdetails = "Deadline Exceeded"\n>'

let seq = 0
function ev(service: string, node: string, minute: number, message: string, sec = 0): ErrorEvent {
  seq++
  return {
    id: `t${seq}:s${seq}`,
    timestamp: at(minute, sec),
    service,
    traceId: `t${seq}`,
    spanId: `s${seq}`,
    errorMessage: message,
    affectedNode: node,
  } as ErrorEvent
}

function svc(g: NeatGraph, name: string): void {
  g.addNode(`service:${name}`, { id: `service:${name}`, type: NodeType.ServiceNode, name, language: 'python' } as GraphNode)
}
function edge(g: NeatGraph, type: string, from: string, to: string, prov: Provenance, count = 0, errors = 0): void {
  const id = `${type}:${prov}:${from}->${to}`
  g.addEdgeWithKey(id, from, to, {
    id,
    source: from,
    target: to,
    type,
    provenance: prov,
    ...(count > 0 ? { callCount: count, signal: { spanCount: count, errorCount: errors } } : {}),
  } as GraphEdge)
}

// The astronomy topology the live daemon held: load-generator calls frontend-proxy
// and flagd and nothing calls it (its only inbound edge is a docker-compose
// EXTRACTED one); fraud-detection consumes from Kafka.
function astronomy(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const s of ['load-generator', 'frontend-proxy', 'frontend', 'recommendation', 'product-catalog', 'flagd', 'fraud-detection']) svc(g, s)
  g.addNode('infra:container:frontend-proxy', { id: 'infra:container:frontend-proxy', type: NodeType.InfraNode, name: 'frontend-proxy', provider: 'self', kind: 'container' } as unknown as GraphNode)
  g.addNode('infra:kafka-topic:orders', { id: 'infra:kafka-topic:orders', type: NodeType.InfraNode, name: 'orders', provider: 'kafka', kind: 'kafka-topic' } as unknown as GraphNode)
  edge(g, EdgeType.DEPENDS_ON, 'infra:container:frontend-proxy', 'service:load-generator', Provenance.EXTRACTED)
  edge(g, EdgeType.CALLS, 'service:load-generator', 'service:frontend-proxy', Provenance.OBSERVED, 702, 147)
  edge(g, EdgeType.CALLS, 'service:load-generator', 'service:flagd', Provenance.OBSERVED, 80, 80)
  edge(g, EdgeType.CALLS, 'service:frontend-proxy', 'service:frontend', Provenance.OBSERVED, 700, 140)
  edge(g, EdgeType.CALLS, 'service:frontend', 'service:recommendation', Provenance.OBSERVED, 300, 40)
  edge(g, EdgeType.CALLS, 'service:recommendation', 'service:product-catalog', Provenance.OBSERVED, 300, 30)
  edge(g, EdgeType.CONSUMES_FROM, 'service:fraud-detection', 'infra:kafka-topic:orders', Provenance.OBSERVED, 50, 0)
  edge(g, EdgeType.CALLS, 'service:fraud-detection', 'service:flagd', Provenance.OBSERVED, 3, 2)
  return g
}

// 30 minutes of store. load-generator and frontend fail steadily from minute 0;
// recommendation starts failing at minute 26 (product-catalog slowed).
function ledger(): ErrorEvent[] {
  const out: ErrorEvent[] = []
  for (let m = 0; m < 30; m++) {
    for (let k = 0; k < 6; k++) out.push(ev('load-generator', 'service:load-generator', m, k % 3 === 0 ? 'HTTP 500' : FLAGD_TIMEOUT, k * 9))
    out.push(ev('frontend', 'service:frontend', m, 'gRPC UNKNOWN', 30))
  }
  for (let m = 26; m < 30; m++) {
    for (let k = 0; k < 3; k++) {
      out.push(ev('recommendation', 'symbol:recommendation:recommendation_server.py#get_product_list', m, DEADLINE, 10 + k * 15))
    }
  }
  out.push(ev('fraud-detection', 'service:fraud-detection', 12, 'StatusCode.UNAVAILABLE recvmsg:Connection reset by peer'))
  out.push(ev('fraud-detection', 'service:fraud-detection', 13, 'StatusCode.UNAVAILABLE recvmsg:Connection reset by peer'))
  return out
}

describe('the incident lead (ADR-264)', () => {
  it('leads with the fault that started in the window, not the chronic noise', () => {
    const lead = incidentLead(astronomy(), ledger())
    expect(IncidentLeadSchema.parse(lead)).toBeTruthy()
    expect(lead.ranked[0]).toMatchObject({
      node: 'symbol:recommendation:recommendation_server.py#get_product_list',
      onset: 'new',
      count: 12,
      windowCount: 12,
    })
    const frontend = lead.ranked.find((r) => r.node === 'service:frontend')!
    expect(frontend).toMatchObject({ onset: 'steady', count: 30, windowCount: 10 })
    expect(lead.window).toEqual({ from: at(19, 45), to: at(29, 45), ms: 600_000 })
  })

  it('never ranks the traffic source; lists it apart with the callees it got errors from', () => {
    const lead = incidentLead(astronomy(), ledger())
    expect(lead.ranked.map((r) => r.node)).not.toContain('service:load-generator')
    expect(lead.trafficSources).toEqual([
      {
        node: 'service:load-generator',
        count: 180,
        latest: at(29, 45),
        message: FLAGD_TIMEOUT,
        callees: ['service:frontend-proxy', 'service:flagd'],
      },
    ])
  })

  it('a queue consumer is not a traffic source: its work arrives from the topic', () => {
    const g = astronomy()
    expect(trafficSourceCallees(g, 'service:fraud-detection', 2)).toBeNull()
    expect(incidentLead(g, ledger()).ranked.map((r) => r.node)).toContain('service:fraud-detection')
  })

  it('a runtime caller, or more incidents than outbound errors, makes it no traffic source', () => {
    const g = astronomy()
    expect(trafficSourceCallees(g, 'service:load-generator', 180)).toEqual(['service:frontend-proxy', 'service:flagd'])
    // More incidents than its outbound calls failed: some are its own.
    expect(trafficSourceCallees(g, 'service:load-generator', 500)).toBeNull()
    // Something calls it at runtime.
    edge(g, EdgeType.CALLS, 'service:frontend', 'service:load-generator', Provenance.OBSERVED, 5, 0)
    expect(trafficSourceCallees(g, 'service:load-generator', 180)).toBeNull()
  })

  it('reads a sharp rise on a node that was already failing as rising, above steady', () => {
    const events = ledger().filter((e) => !e.affectedNode.startsWith('symbol:'))
    for (let m = 24; m < 30; m++) for (let k = 0; k < 8; k++) events.push(ev('frontend', 'service:frontend', m, 'gRPC UNAVAILABLE', k * 5))
    events.push(ev('product-catalog', 'service:product-catalog', 2, 'slow'))
    events.push(ev('product-catalog', 'service:product-catalog', 25, 'slow'))
    const lead = incidentLead(astronomy(), events)
    expect(lead.ranked[0]).toMatchObject({ node: 'service:frontend', onset: 'rising' })
  })

  it('a node quiet in the window ranks last', () => {
    const lead = incidentLead(astronomy(), ledger())
    expect(lead.ranked.at(-1)).toMatchObject({ node: 'service:fraud-detection', onset: 'quiet', windowCount: 0 })
  })

  it('without a graph it still orders by onset', () => {
    const lead = incidentLead(undefined, ledger())
    expect(lead.ranked[0]!.node).toBe('symbol:recommendation:recommendation_server.py#get_product_list')
    expect(lead.trafficSources).toEqual([])
  })
})

describe('ask reads the lead (ADR-264)', () => {
  it('"what is failing right now and why?" starts from the new fault', async () => {
    const res = await askGraph(astronomy(), 'what is failing right now and why?', { incidents: ledger() })
    expect(res.answer).toContain('Start with symbol:recommendation:recommendation_server.py#get_product_list')
    expect(res.answer).not.toContain('Start with service:load-generator')
    const facts = res.sections[0]!.facts.map((f) => f.text)
    expect(facts.at(-1)).toContain('service:load-generator — traffic source, not a culprit: 180 errors on its own calls to service:frontend-proxy, service:flagd')
  })

  it('a store holding only what the traffic source received names no culprit', async () => {
    const only = ledger().filter((e) => e.service === 'load-generator')
    const res = await askGraph(astronomy(), 'what is failing right now and why?', { incidents: only })
    expect(res.answer).toMatch(/^None of the recorded incidents is on a node failing in its own right/)
  })
})

describe('GET /incidents/lead', () => {
  let tmp: string
  let app: Awaited<ReturnType<typeof buildApi>>
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-incident-lead-'))
    const errorsPath = path.join(tmp, 'errors.ndjson')
    await fs.writeFile(errorsPath, ledger().map((e) => JSON.stringify(e)).join('\n') + '\n')
    app = await buildApi({ graph: astronomy(), errorsPath })
  })
  afterEach(async () => {
    await app.close()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('serves the same lead', async () => {
    const res = await app.inject({ method: 'GET', url: '/incidents/lead' })
    expect(res.statusCode).toBe(200)
    const body = IncidentLeadSchema.parse(res.json())
    expect(body.ranked[0]!.node).toBe('symbol:recommendation:recommendation_server.py#get_product_list')
    expect(body.trafficSources.map((t) => t.node)).toEqual(['service:load-generator'])
  })

  it('does not shadow a node literally queried by id', async () => {
    const res = await app.inject({ method: 'GET', url: '/incidents/service:frontend' })
    expect(res.statusCode).toBe(200)
  })
})

// #1488 — a connector incident whose workload the connector observes Ready again is
// over: it ranks nowhere in the lead and leads no card, while the store keeps it.
describe('the incident lead clears a recovered connector incident (#1488)', () => {
  const k8sGraph = (ready: Record<string, number | undefined>): NeatGraph => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    for (const [node, r] of Object.entries(ready)) {
      g.addNode(node, {
        id: node,
        type: NodeType.ServiceNode,
        name: node.replace(/^service:/, ''),
        ...(typeof r === 'number' ? { observedReadyReplicas: r } : {}),
      } as GraphNode)
    }
    return g
  }
  const k8sIncident = (node: string, minute: number): ErrorEvent =>
    ({
      id: `k8s:deploy:default:${node.replace(/^service:/, '')}:no-ready-replicas`,
      timestamp: at(minute),
      service: node.replace(/^service:/, ''),
      traceId: node,
      spanId: node,
      errorType: 'k8s-deploy-failure',
      errorMessage: `Deployment ${node.replace(/^service:/, '')} has no ready replicas`,
      affectedNode: node,
    }) as ErrorEvent

  it('drops the incident whose workload is observed Ready, keeps one still at zero', () => {
    const g = k8sGraph({ 'service:mongodb-user': 1, 'service:recommendation': 0 })
    const lead = incidentLead(g, [k8sIncident('service:mongodb-user', 0), k8sIncident('service:recommendation', 5)])
    expect(lead.ranked.map((r) => r.node)).toEqual(['service:recommendation'])
    expect(lead.total).toBe(1)
  })

  it('without a graph, nothing is read as recovered', () => {
    const lead = incidentLead(undefined, [k8sIncident('service:mongodb-user', 0)])
    expect(lead.ranked.map((r) => r.node)).toEqual(['service:mongodb-user'])
    expect(lead.total).toBe(1)
  })

  it('a workload with no observed replica count keeps its incident (recovery is never assumed)', () => {
    const g = k8sGraph({ 'service:mongodb-user': undefined })
    expect(incidentLead(g, [k8sIncident('service:mongodb-user', 0)]).ranked.map((r) => r.node)).toEqual([
      'service:mongodb-user',
    ])
  })

  it('clears only a k8s-deploy-failure; a span incident on a Ready node still ranks', () => {
    const g = k8sGraph({ 'service:frontend': 3 })
    expect(incidentLead(g, [ev('frontend', 'service:frontend', 0, 'gRPC UNKNOWN')]).ranked.map((r) => r.node)).toEqual([
      'service:frontend',
    ])
  })
})

describe('GET /graph/incident-card skips a recovered connector incident (#1488)', () => {
  let tmp: string
  let app: Awaited<ReturnType<typeof buildApi>>
  const recoveredId = 'k8s:deploy:default:mongodb-user:no-ready-replicas'
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-1488-card-'))
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:mongodb-user', {
      id: 'service:mongodb-user',
      type: NodeType.ServiceNode,
      name: 'mongodb-user',
      observedReadyReplicas: 1,
    } as GraphNode)
    const inc: ErrorEvent = {
      id: recoveredId,
      timestamp: at(0),
      service: 'mongodb-user',
      traceId: recoveredId,
      spanId: recoveredId,
      errorType: 'k8s-deploy-failure',
      errorMessage: 'Deployment mongodb-user has no ready replicas',
      affectedNode: 'service:mongodb-user',
    } as ErrorEvent
    const errorsPath = path.join(tmp, 'errors.ndjson')
    await fs.writeFile(errorsPath, JSON.stringify(inc) + '\n')
    app = await buildApi({ graph: g, errorsPath })
  })
  afterEach(async () => {
    await app.close()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('the "now" card composes from the graph — the recovered incident does not lead it', async () => {
    const res = await app.inject({ method: 'GET', url: '/graph/incident-card/service:mongodb-user' })
    expect(res.statusCode).toBe(200)
    expect(res.json().noIncident?.reason).toContain('no recorded incident')
  })

  it('an explicit ?errorId= still returns the exact incident', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/graph/incident-card/service:mongodb-user?errorId=${encodeURIComponent(recoveredId)}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().message).toContain('no ready replicas')
  })
})
