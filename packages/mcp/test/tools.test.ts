import { describe, expect, it } from 'vitest'
import { EdgeType, NodeType, Provenance } from '@neat.is/types'
import { HttpError, type HttpClient } from '../src/client.js'
import {
  getBlastRadius,
  getDependencies,
  getGraphDiff,
  getIncidentHistory,
  getObservedDependencies,
  getRecentStaleEdges,
  getRootCause,
  semanticSearch,
} from '../src/tools.js'

interface Capture {
  paths: string[]
}

// Decoded lookup so test keys can read like '/incidents/database:payments-db'
// instead of '/incidents/database%3Apayments-db'. Capture records the raw,
// pre-decode path so tests can assert on actual encoding.
function decodePath(p: string): string {
  const [base, ...rest] = p.split('?')
  return decodeURIComponent(base) + (rest.length ? '?' + rest.join('?') : '')
}

function clientFor(map: Record<string, unknown>, capture: Capture = { paths: [] }): {
  client: HttpClient
  capture: Capture
} {
  return {
    capture,
    client: {
      async get<T>(path: string): Promise<T> {
        capture.paths.push(path)
        const decoded = decodePath(path)
        if (decoded in map) return map[decoded] as T
        if (path in map) return map[path] as T
        throw new HttpError(404, `404 on ${path}`)
      },
    },
  }
}

function errorClient(err: Error): HttpClient {
  return {
    async get<T>(): Promise<T> {
      throw err
    },
  }
}

describe('getRootCause', () => {
  it('formats RootCauseResult as natural language with arrow path', async () => {
    const { client, capture } = clientFor({
      '/graph/root-cause/database:payments-db': {
        rootCauseNode: 'service:service-b',
        rootCauseReason:
          'PostgreSQL 14+ requires scram-sha-256; pg < 8.0.0 only speaks md5.',
        traversalPath: ['database:payments-db', 'service:service-b', 'service:service-a'],
        edgeProvenances: [Provenance.OBSERVED, Provenance.OBSERVED],
        confidence: 1,
        fixRecommendation: 'Upgrade service-b pg driver to >= 8.0.0',
      },
    })
    const res = await getRootCause(client, { errorNode: 'database:payments-db' })
    expect(res.isError).toBeFalsy()
    const text = res.content[0].text
    // Three-part response per ADR-039: summary + block + footer.
    expect(text).toContain('Root cause for database:payments-db is service:service-b')
    expect(text).toContain('database:payments-db ← service:service-b ← service:service-a')
    expect(text).toContain('OBSERVED, OBSERVED')
    expect(text).toContain('Recommended fix: Upgrade service-b pg driver to >= 8.0.0')
    // Footer: confidence as decimal, provenance unique values.
    expect(text).toMatch(/confidence: 1\.00 · provenance: OBSERVED/)
    expect(capture.paths).toEqual(['/graph/root-cause/database%3Apayments-db'])
  })

  it('threads errorId through as a query parameter', async () => {
    const { client, capture } = clientFor({
      '/graph/root-cause/database:payments-db?errorId=trace-1%3Aspan-b': {
        rootCauseNode: 'service:service-b',
        rootCauseReason: 'reason',
        traversalPath: ['database:payments-db', 'service:service-b'],
        edgeProvenances: [Provenance.EXTRACTED],
        confidence: 0.5,
      },
    })
    await getRootCause(client, { errorNode: 'database:payments-db', errorId: 'trace-1:span-b' })
    expect(capture.paths[0]).toBe(
      '/graph/root-cause/database%3Apayments-db?errorId=trace-1%3Aspan-b',
    )
  })

  it('returns a friendly message on 404', async () => {
    const { client } = clientFor({})
    const res = await getRootCause(client, { errorNode: 'database:nope' })
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('No root cause found')
  })

  it('reports a non-404 error as isError', async () => {
    const res = await getRootCause(errorClient(new Error('connect ECONNREFUSED')), {
      errorNode: 'database:payments-db',
    })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('ECONNREFUSED')
  })
})

describe('getBlastRadius', () => {
  it('lists affected nodes sorted by distance with provenance tags', async () => {
    const { client } = clientFor({
      '/graph/blast-radius/service:service-a': {
        origin: 'service:service-a',
        totalAffected: 2,
        affectedNodes: [
          {
            nodeId: 'database:payments-db',
            distance: 2,
            edgeProvenance: Provenance.OBSERVED,
          },
          {
            nodeId: 'service:service-b',
            distance: 1,
            edgeProvenance: Provenance.OBSERVED,
          },
        ],
      },
    })
    const res = await getBlastRadius(client, { nodeId: 'service:service-a' })
    const text = res.content[0].text
    expect(text).toContain('Blast radius for service:service-a: 2 affected nodes')
    // service-b at distance 1 should appear before payments-db at distance 2
    const lines = text.split('\n')
    const bIdx = lines.findIndex((l) => l.includes('service:service-b'))
    const dbIdx = lines.findIndex((l) => l.includes('database:payments-db'))
    expect(bIdx).toBeGreaterThan(0)
    expect(dbIdx).toBeGreaterThan(bIdx)
    expect(text).toMatch(/provenance: OBSERVED/)
  })

  it('flags STALE edges explicitly', async () => {
    const { client } = clientFor({
      '/graph/blast-radius/service:service-a': {
        origin: 'service:service-a',
        totalAffected: 1,
        affectedNodes: [
          {
            nodeId: 'service:service-b',
            distance: 1,
            edgeProvenance: Provenance.STALE,
          },
        ],
      },
    })
    const res = await getBlastRadius(client, { nodeId: 'service:service-a' })
    expect(res.content[0].text).toContain('[STALE')
  })

  it('handles a node with no downstream nodes', async () => {
    const { client } = clientFor({
      '/graph/blast-radius/database:payments-db': {
        origin: 'database:payments-db',
        totalAffected: 0,
        affectedNodes: [],
      },
    })
    const res = await getBlastRadius(client, { nodeId: 'database:payments-db' })
    expect(res.content[0].text).toContain('no downstream dependencies')
  })

  it('passes depth as a query parameter', async () => {
    const { client, capture } = clientFor({
      '/graph/blast-radius/service:service-a?depth=1': {
        origin: 'service:service-a',
        totalAffected: 0,
        affectedNodes: [],
      },
    })
    await getBlastRadius(client, { nodeId: 'service:service-a', depth: 1 })
    expect(capture.paths[0]).toBe('/graph/blast-radius/service%3Aservice-a?depth=1')
  })

  it('surfaces file-grained nodes in the formatted output (#392)', async () => {
    // A file-first graph returns file node ids in affectedNodes; the formatter
    // is node-type agnostic and must surface them verbatim.
    const { client } = clientFor({
      '/graph/blast-radius/service:service-a': {
        origin: 'service:service-a',
        totalAffected: 2,
        affectedNodes: [
          { nodeId: 'file:service-a:index.js', distance: 1, edgeProvenance: Provenance.EXTRACTED },
          { nodeId: 'service:service-b', distance: 2, edgeProvenance: Provenance.EXTRACTED },
        ],
      },
    })
    const res = await getBlastRadius(client, { nodeId: 'service:service-a' })
    expect(res.content[0].text).toContain('file:service-a:index.js')
  })
})

describe('getDependencies', () => {
  it('returns transitive dependencies grouped by distance with best provenance per pair (#144)', async () => {
    const { client } = clientFor({
      '/graph/dependencies/service:service-a?depth=3': {
        origin: 'service:service-a',
        depth: 3,
        total: 2,
        dependencies: [
          {
            nodeId: 'service:service-b',
            distance: 1,
            edgeType: EdgeType.CALLS,
            provenance: Provenance.OBSERVED,
          },
          {
            nodeId: 'database:payments-db',
            distance: 2,
            edgeType: EdgeType.CONNECTS_TO,
            provenance: Provenance.EXTRACTED,
          },
        ],
      },
    })
    const res = await getDependencies(client, { nodeId: 'service:service-a' })
    const text = res.content[0].text
    expect(text).toContain('service:service-a has 2 dependencies reachable to depth 3 (1 direct)')
    expect(text).toContain('Direct (distance 1):')
    expect(text).toContain('service:service-b — CALLS (OBSERVED)')
    expect(text).toContain('Distance 2:')
    expect(text).toContain('database:payments-db — CONNECTS_TO (EXTRACTED)')
    expect(text).toMatch(/provenance: OBSERVED, EXTRACTED|provenance: EXTRACTED, OBSERVED/)
  })

  it('returns a friendly message when there are no dependencies', async () => {
    const { client } = clientFor({
      '/graph/dependencies/database:payments-db?depth=3': {
        origin: 'database:payments-db',
        depth: 3,
        total: 0,
        dependencies: [],
      },
    })
    const res = await getDependencies(client, { nodeId: 'database:payments-db' })
    expect(res.content[0].text).toContain('no dependencies')
  })

  it('depth=1 returns direct dependencies only', async () => {
    const { client, capture } = clientFor({
      '/graph/dependencies/service:service-a?depth=1': {
        origin: 'service:service-a',
        depth: 1,
        total: 1,
        dependencies: [
          {
            nodeId: 'service:service-b',
            distance: 1,
            edgeType: EdgeType.CALLS,
            provenance: Provenance.OBSERVED,
          },
        ],
      },
    })
    const res = await getDependencies(client, { nodeId: 'service:service-a', depth: 1 })
    expect(capture.paths[0]).toBe('/graph/dependencies/service%3Aservice-a?depth=1')
    expect(res.content[0].text).toContain('service:service-a has 1 direct dependency')
  })
})

describe('getObservedDependencies', () => {
  it('filters to OBSERVED only and includes lastObserved + callCount', async () => {
    const { client } = clientFor({
      '/graph/edges/service:service-a': {
        inbound: [],
        outbound: [
          {
            id: 'CALLS:service:service-a->service:service-b',
            source: 'service:service-a',
            target: 'service:service-b',
            type: EdgeType.CALLS,
            provenance: Provenance.EXTRACTED,
          },
          {
            id: 'CALLS:OBSERVED:service:service-a->service:service-b',
            source: 'service:service-a',
            target: 'service:service-b',
            type: EdgeType.CALLS,
            provenance: Provenance.OBSERVED,
            confidence: 1,
            callCount: 11,
            lastObserved: '2026-05-01T15:51:11.967Z',
          },
        ],
      },
    })
    const res = await getObservedDependencies(client, { nodeId: 'service:service-a' })
    const text = res.content[0].text
    expect(text).toContain('service:service-a has 1 runtime dependency confirmed by OTel')
    expect(text).toContain('service:service-b')
    expect(text).toContain('lastObserved=2026-05-01T15:51:11.967Z')
    expect(text).toMatch(/provenance: OBSERVED/)
  })

  it('explains the OTel-down case when only EXTRACTED edges exist', async () => {
    const { client } = clientFor({
      '/graph/edges/service:service-a': {
        inbound: [],
        outbound: [
          {
            id: 'CALLS:service:service-a->service:service-b',
            source: 'service:service-a',
            target: 'service:service-b',
            type: EdgeType.CALLS,
            provenance: Provenance.EXTRACTED,
          },
        ],
      },
    })
    const res = await getObservedDependencies(client, { nodeId: 'service:service-a' })
    expect(res.content[0].text).toContain('OTel running')
  })
})

describe('getIncidentHistory', () => {
  it('returns events newest first with trace and span ids', async () => {
    const { client } = clientFor({
      '/incidents/database:payments-db': {
        count: 2,
        total: 2,
        events: [
          {
            id: 'trace-1:span-1',
            timestamp: '2026-05-01T15:00:00.000Z',
            service: 'service-b',
            traceId: 'trace-1',
            spanId: 'span-1',
            errorMessage: 'older',
            affectedNode: 'database:payments-db',
          },
          {
            id: 'trace-2:span-2',
            timestamp: '2026-05-01T15:30:00.000Z',
            service: 'service-b',
            traceId: 'trace-2',
            spanId: 'span-2',
            errorMessage: 'SCRAM-SERVER-FIRST-MESSAGE',
            affectedNode: 'database:payments-db',
          },
        ],
      },
    })
    const res = await getIncidentHistory(client, { nodeId: 'database:payments-db' })
    const text = res.content[0].text
    expect(text).toContain('database:payments-db has 2 recorded incidents')
    expect(text).toContain('showing the 2 most recent')
    const newerIdx = text.indexOf('SCRAM')
    const olderIdx = text.indexOf('older')
    expect(newerIdx).toBeGreaterThan(0)
    expect(newerIdx).toBeLessThan(olderIdx)
    expect(text).toContain('trace=trace-2 span=span-2')
  })

  it('honours limit', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      id: `t:${i}`,
      timestamp: `2026-05-01T15:0${i}:00.000Z`,
      service: 's',
      traceId: `trace-${i}`,
      spanId: `span-${i}`,
      errorMessage: `e${i}`,
      affectedNode: 'database:payments-db',
    }))
    const { client } = clientFor({
      '/incidents/database:payments-db': { count: 5, total: 5, events },
    })
    const res = await getIncidentHistory(client, { nodeId: 'database:payments-db', limit: 2 })
    expect(res.content[0].text).toContain('has 5 recorded incidents')
    expect(res.content[0].text).toContain('showing the 2 most recent')
  })

  it('returns a friendly message for an empty list', async () => {
    const { client } = clientFor({
      '/incidents/service:service-a': { count: 0, total: 0, events: [] },
    })
    const res = await getIncidentHistory(client, { nodeId: 'service:service-a' })
    expect(res.content[0].text).toContain('No incidents recorded')
  })
})

describe('semanticSearch', () => {
  it('formats matches with id, type, and name', async () => {
    const { client } = clientFor({
      '/search?q=service-b': {
        query: 'service-b',
        matches: [
          {
            id: 'service:service-b',
            type: NodeType.ServiceNode,
            name: 'service-b',
            language: 'javascript',
          },
        ],
      },
    })
    const res = await semanticSearch(client, { query: 'service-b' })
    expect(res.content[0].text).toContain('service:service-b (ServiceNode) — service-b')
  })

  it('returns a friendly message when there are no matches', async () => {
    const { client } = clientFor({
      '/search?q=nothing': { query: 'nothing', matches: [] },
    })
    const res = await semanticSearch(client, { query: 'nothing' })
    expect(res.content[0].text).toContain('No matches')
  })
})

describe('getGraphDiff', () => {
  const baseExportedAt = '2026-04-25T10:00:00.000Z'
  const currentExportedAt = '2026-05-02T10:00:00.000Z'

  it('formats added/removed/changed sections', async () => {
    const { client, capture } = clientFor({
      '/graph/diff?against=.%2Fsnapshots%2Flast-week.json': {
        base: { exportedAt: baseExportedAt },
        current: { exportedAt: currentExportedAt },
        added: {
          nodes: [
            {
              id: 'service:checkout',
              type: NodeType.ServiceNode,
              name: 'checkout',
              language: 'javascript',
            },
          ],
          edges: [
            {
              id: 'CALLS:OBSERVED:service:service-a->service:checkout',
              source: 'service:service-a',
              target: 'service:checkout',
              type: EdgeType.CALLS,
              provenance: Provenance.OBSERVED,
            },
          ],
        },
        removed: { nodes: [], edges: [] },
        changed: {
          nodes: [],
          edges: [
            {
              id: 'CONNECTS_TO:OBSERVED:service:service-b->database:payments-db',
              before: {
                id: 'CONNECTS_TO:OBSERVED:service:service-b->database:payments-db',
                source: 'service:service-b',
                target: 'database:payments-db',
                type: EdgeType.CONNECTS_TO,
                provenance: Provenance.OBSERVED,
                callCount: 12,
              },
              after: {
                id: 'CONNECTS_TO:OBSERVED:service:service-b->database:payments-db',
                source: 'service:service-b',
                target: 'database:payments-db',
                type: EdgeType.CONNECTS_TO,
                provenance: Provenance.STALE,
                callCount: 12,
                confidence: 0.3,
              },
            },
          ],
        },
      },
    })
    const res = await getGraphDiff(client, { againstSnapshot: './snapshots/last-week.json' })
    expect(res.isError).toBeFalsy()
    const out = res.content[0].text
    expect(out).toContain('Diff against ./snapshots/last-week.json')
    expect(out).toContain(`base exportedAt:    ${baseExportedAt}`)
    expect(out).toContain(`current exportedAt: ${currentExportedAt}`)
    expect(out).toContain('+ node service:checkout')
    expect(out).toContain('+ edge CALLS:OBSERVED:service:service-a->service:checkout')
    expect(out).toContain(
      '~ edge CONNECTS_TO:OBSERVED:service:service-b->database:payments-db — provenance OBSERVED → STALE',
    )
    expect(capture.paths).toEqual([
      '/graph/diff?against=.%2Fsnapshots%2Flast-week.json',
    ])
  })

  it('reports an empty diff with both timestamps', async () => {
    const { client } = clientFor({
      '/graph/diff?against=.%2Fsame.json': {
        base: { exportedAt: baseExportedAt },
        current: { exportedAt: currentExportedAt },
        added: { nodes: [], edges: [] },
        removed: { nodes: [], edges: [] },
        changed: { nodes: [], edges: [] },
      },
    })
    const res = await getGraphDiff(client, { againstSnapshot: './same.json' })
    expect(res.content[0].text).toContain('No differences')
    expect(res.content[0].text).toContain(baseExportedAt)
  })

  it('surfaces a friendly error when the snapshot cannot be loaded', async () => {
    const client: HttpClient = {
      async get<T>(): Promise<T> {
        throw new HttpError(400, '400 on /graph/diff?against=oops')
      },
    }
    const res = await getGraphDiff(client, { againstSnapshot: 'oops' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('Could not load snapshot oops')
  })
})

describe('getRecentStaleEdges', () => {
  it('formats a list of stale-edge transitions newest-first', async () => {
    const { client, capture } = clientFor({
      '/stale-events': {
        count: 2,
        total: 2,
        events: [
          {
            edgeId: 'CONNECTS_TO:OBSERVED:service:b->database:c',
            source: 'service:b',
            target: 'database:c',
            edgeType: 'CONNECTS_TO',
            thresholdMs: 14400000,
            ageMs: 15000000,
            lastObserved: '2026-05-02T07:00:00.000Z',
            transitionedAt: '2026-05-02T11:10:00.000Z',
          },
          {
            edgeId: 'CALLS:OBSERVED:service:a->service:b',
            source: 'service:a',
            target: 'service:b',
            edgeType: 'CALLS',
            thresholdMs: 3600000,
            ageMs: 5400000,
            lastObserved: '2026-05-02T10:00:00.000Z',
            transitionedAt: '2026-05-02T11:30:00.000Z',
          },
        ],
      },
    })
    const res = await getRecentStaleEdges(client, {})
    const out = res.content[0].text
    expect(out).toContain('2 stale-edge transitions recorded')
    expect(out).toContain('service:b -[CONNECTS_TO]-> database:c')
    expect(out).toContain('service:a -[CALLS]-> service:b')
    expect(out).toMatch(/provenance: STALE/)
    expect(capture.paths[0]).toBe('/stale-events')
  })

  it('returns a friendly empty message', async () => {
    const { client } = clientFor({
      '/stale-events': { count: 0, total: 0, events: [] },
    })
    const res = await getRecentStaleEdges(client, {})
    expect(res.content[0].text).toContain('No stale-edge transitions')
  })

  it('passes edgeType + limit query params', async () => {
    const { client, capture } = clientFor({
      '/stale-events?limit=10&edgeType=CALLS': { count: 0, total: 0, events: [] },
    })
    await getRecentStaleEdges(client, { limit: 10, edgeType: 'CALLS' })
    expect(capture.paths[0]).toContain('limit=10')
    expect(capture.paths[0]).toContain('edgeType=CALLS')
  })
})

describe('project routing', () => {
  it('threads project through every tool URL when set', async () => {
    const { client, capture } = clientFor({
      '/projects/alpha/graph/root-cause/database:payments-db': {
        rootCauseNode: 'service:service-b',
        rootCauseReason: 'reason',
        traversalPath: ['database:payments-db', 'service:service-b'],
        edgeProvenances: [Provenance.OBSERVED],
        confidence: 0.9,
      },
      '/projects/alpha/graph/blast-radius/service:a': {
        origin: 'service:a',
        totalAffected: 0,
        affectedNodes: [],
      },
      '/projects/alpha/graph/edges/service:a': { inbound: [], outbound: [] },
      '/projects/alpha/graph/dependencies/service:a?depth=3': {
        origin: 'service:a',
        depth: 3,
        total: 0,
        dependencies: [],
      },
      '/projects/alpha/incidents/service:a': { count: 0, total: 0, events: [] },
      '/projects/alpha/search?q=foo': { query: 'foo', provider: 'substring', matches: [] },
      '/projects/alpha/graph/diff?against=snap.json': {
        base: { exportedAt: '2026-01-01' },
        current: { exportedAt: '2026-02-01' },
        added: { nodes: [], edges: [] },
        removed: { nodes: [], edges: [] },
        changed: { nodes: [], edges: [] },
      },
      '/projects/alpha/stale-events': { count: 0, total: 0, events: [] },
    })

    await getRootCause(client, { errorNode: 'database:payments-db', project: 'alpha' })
    await getBlastRadius(client, { nodeId: 'service:a', project: 'alpha' })
    await getDependencies(client, { nodeId: 'service:a', project: 'alpha' })
    await getObservedDependencies(client, { nodeId: 'service:a', project: 'alpha' })
    await getIncidentHistory(client, { nodeId: 'service:a', project: 'alpha' })
    await semanticSearch(client, { query: 'foo', project: 'alpha' })
    await getGraphDiff(client, { againstSnapshot: 'snap.json', project: 'alpha' })
    await getRecentStaleEdges(client, { project: 'alpha' })

    for (const p of capture.paths) {
      expect(p.startsWith('/projects/alpha/')).toBe(true)
    }
  })

  it('falls back to legacy unprefixed URLs when project is omitted', async () => {
    const { client, capture } = clientFor({
      '/graph/root-cause/database:payments-db': {
        rootCauseNode: 'service:b',
        rootCauseReason: 'r',
        traversalPath: ['database:payments-db'],
        edgeProvenances: [],
        confidence: 1,
      },
    })
    await getRootCause(client, { errorNode: 'database:payments-db' })
    expect(capture.paths[0]).toBe('/graph/root-cause/database%3Apayments-db')
  })
})
