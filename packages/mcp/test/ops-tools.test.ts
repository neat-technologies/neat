import { describe, it, expect } from 'vitest'
import { HttpError, type HttpClient } from '../src/client.js'
import {
  getLogs,
  getChanges,
  graphTrust,
  getIncidentLead,
  getEdges,
  connectorHealth,
  policyRead,
} from '../src/tools.js'

// The #1694 read-only ops + policy tools over the REST surface.

function clientFor(map: Record<string, unknown>): HttpClient {
  return {
    async get<T>(p: string): Promise<T> {
      if (p in map) return map[p] as T
      throw new HttpError(404, `404 on ${p}`)
    },
  }
}

describe('get_logs', () => {
  it('shows recent lines newest first with severity, service and message', async () => {
    const client = clientFor({
      '/logs?limit=100': {
        count: 2,
        total: 2,
        logs: [
          { timestamp: '2026-11-15T10:00:00Z', severity: 'info', serviceName: 'web', source: 'native', message: 'started' },
          { timestamp: '2026-11-15T10:01:00Z', severity: 'error', serviceName: 'web', source: 'native', message: 'boom failed to connect' },
        ],
      },
    })
    const text = (await getLogs(client, {})).content[0]!.text
    // newest (10:01 error) leads
    const firstLine = text.split('\n').find((l) => l.includes('10:01:00'))!
    const errIdx = text.indexOf('10:01:00')
    const okIdx = text.indexOf('10:00:00')
    expect(errIdx).toBeLessThan(okIdx)
    expect(firstLine).toContain('[error] web: boom failed to connect')
    expect(text).toContain('2 log lines match')
  })

  it('reports no logs cleanly', async () => {
    const client = clientFor({ '/logs?limit=100': { count: 0, total: 0, logs: [] } })
    expect((await getLogs(client, {})).content[0]!.text).toContain('No logs recorded')
  })
})

describe('get_changes', () => {
  it('lists each change against the healthy baseline with the fields that moved', async () => {
    const client = clientFor({
      '/graph/changes': {
        at: '2026-11-15T10:00:00Z',
        base: { takenAt: '2026-11-14T00:00:00Z' },
        changes: [
          { id: 'c1', kind: 'flag', node: 'flag-store:main', change: 'modified', fields: [{ path: 'checkout', before: true, after: false }] },
        ],
        provenance: 'OBSERVED',
      },
    })
    const text = (await getChanges(client, {})).content[0]!.text
    expect(text).toContain('1 change since the last healthy baseline (2026-11-14T00:00:00Z)')
    expect(text).toContain('[flag] modified flag-store:main (checkout: true → false)')
  })

  it('says when there is nothing changed', async () => {
    const client = clientFor({ '/graph/changes': { at: 'x', base: { takenAt: 'y' }, changes: [] } })
    expect((await getChanges(client, {})).content[0]!.text).toContain('No changes since the last healthy baseline')
  })
})

describe('graph_trust', () => {
  const health = (over: Record<string, unknown>) => ({
    '/projects/default/health': { project: 'shop', nodeCount: 120, edgeCount: 240, lastUpdated: '2026-11-15T10:00:00Z', ...over },
  })
  it('calls a clean pass trustworthy', async () => {
    const text = (await graphTrust(clientFor(health({ coverage: { skippedFiles: 0 } })), {})).content[0]!.text
    expect(text).toContain('120 nodes, 240 edges')
    expect(text).toContain('the last extraction pass was clean')
    expect(text).toContain('Trust: trustworthy')
  })
  it('calls a partial pass partial, and a missing-coverage graph not ready', async () => {
    expect((await graphTrust(clientFor(health({ coverage: { skippedFiles: 3 } })), {})).content[0]!.text).toContain('Trust: partial')
    expect((await graphTrust(clientFor(health({})), {})).content[0]!.text).toContain('Trust: not ready')
  })
})

describe('get_incident_lead', () => {
  it('leads with the top culprit and points at investigate', async () => {
    const client = clientFor({
      '/incidents/lead': {
        window: { from: 'a', to: 'b', ms: 1 },
        total: 2,
        ranked: [
          { node: 'service:checkout', count: 5, windowCount: 3, firstSeen: 'a', latest: 'b', message: 'ECONNREFUSED', onset: 'rising' },
        ],
        trafficSources: [{ node: 'service:loadgen', count: 9, latest: 'b', message: 'x', callees: [] }],
      },
    })
    const text = (await getIncidentLead(client, {})).content[0]!.text
    expect(text).toContain('Start with service:checkout (rising)')
    expect(text).toContain('investigate("service:checkout")')
    expect(text).toContain('• service:checkout — rising, 3 in window (5 total)')
    expect(text).toContain('traffic sources (never culprits): service:loadgen')
  })
  it('says when nothing is failing', async () => {
    const client = clientFor({ '/incidents/lead': { window: { from: 'a', to: 'b', ms: 1 }, total: 0, ranked: [], trafficSources: [] } })
    expect((await getIncidentLead(client, {})).content[0]!.text).toContain('No open incidents')
  })
})

describe('get_edges', () => {
  it('lists inbound and outbound edges with counts', async () => {
    const client = clientFor({
      '/graph/edges/service%3Aweb': {
        outbound: [{ id: 'e1', source: 'service:web', target: 'database:pg', type: 'CONNECTS_TO', provenance: 'OBSERVED' }],
        inbound: [{ id: 'e2', source: 'service:gw', target: 'service:web', type: 'CALLS', provenance: 'EXTRACTED' }],
      },
    })
    const text = (await getEdges(client, { nodeId: 'service:web' })).content[0]!.text
    expect(text).toContain('service:web: 1 outbound, 1 inbound edge')
    expect(text).toContain('→ database:pg (CONNECTS_TO, OBSERVED)')
    expect(text).toContain('← service:gw (CALLS, EXTRACTED)')
  })
  it('reports a node with no edges', async () => {
    const client = clientFor({ '/graph/edges/service%3Ax': { inbound: [], outbound: [] } })
    expect((await getEdges(client, { nodeId: 'service:x' })).content[0]!.text).toContain('has no edges')
  })
})

describe('connector_health', () => {
  it('tallies connector states and lists each with its last poll', async () => {
    const client = clientFor({
      '/connectors': {
        connectors: [
          { id: 'c1', provider: 'supabase', status: { state: 'healthy', lastPollAt: '2026-11-15T10:00:00Z', lastOutcome: 'ok', lastError: null, signalsLastPoll: 12 } },
          { id: 'c2', provider: 'railway', status: { state: 'error', lastPollAt: '2026-11-15T09:00:00Z', lastOutcome: 'error', lastError: 'Not Authorized', signalsLastPoll: 0 } },
        ],
      },
    })
    const text = (await connectorHealth(client, {})).content[0]!.text
    expect(text).toContain('2 connectors: 1 healthy, 1 error')
    expect(text).toContain('supabase c1: healthy')
    expect(text).toContain('railway c2: error')
    expect(text).toContain('error: Not Authorized')
  })
  it('reports no connectors', async () => {
    expect((await connectorHealth(clientFor({ '/connectors': { connectors: [] } }), {})).content[0]!.text).toContain('No connectors')
  })
})

describe('policy_read', () => {
  it('lists the authored policies and points violations/applicable at check_policies', async () => {
    const client = clientFor({
      '/policies': {
        version: 1,
        policies: [{ id: 'svc-owner', name: 'services declare an owner', severity: 'critical', onViolation: 'block', rule: { type: 'ownership' } }],
      },
    })
    const text = (await policyRead(client, {})).content[0]!.text
    expect(text).toContain('1 authored policy')
    expect(text).toContain('[critical/block] svc-owner (ownership): services declare an owner')
    expect(text).toContain('check_policies')
  })
  it('says when no policies are authored', async () => {
    expect((await policyRead(clientFor({ '/policies': { version: 1, policies: [] } }), {})).content[0]!.text).toContain('No policies are authored')
  })
})
