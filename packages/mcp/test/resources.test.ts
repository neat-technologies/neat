import { describe, expect, it } from 'vitest'
import { EdgeType, NodeType, Provenance } from '@neat.is/types'
import type { HttpClient } from '../src/client.js'
import { HttpError } from '../src/client.js'
import {
  incidentsChanged,
  listNodeResources,
  readNodeResource,
  readRecentIncidentsResource,
  readStatusResource,
} from '../src/resources.js'

interface Capture {
  paths: string[]
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
        const decoded = decodeURIComponent(path.split('?')[0])
        if (decoded in map) return map[decoded] as T
        if (path in map) return map[path] as T
        throw new HttpError(404, `404 on ${path}`)
      },
    },
  }
}

describe('listNodeResources', () => {
  it('returns one resource per graph node with neat://node/<id> URIs', async () => {
    const { client } = clientFor({
      '/graph': {
        nodes: [
          {
            id: 'service:service-a',
            type: NodeType.ServiceNode,
            name: 'service-a',
            language: 'javascript',
          },
          {
            id: 'database:payments-db',
            type: NodeType.DatabaseNode,
            name: 'payments-db',
            engine: 'postgresql',
            engineVersion: '15',
          },
        ],
        edges: [],
      },
    })
    const result = await listNodeResources(client)
    expect(result.resources).toHaveLength(2)
    expect(result.resources[0].uri).toBe('neat://node/service%3Aservice-a')
    expect(result.resources[0].name).toBe('service-a')
    expect(result.resources[0].mimeType).toBe('application/json')
    expect(result.resources[1].uri).toBe('neat://node/database%3Apayments-db')
  })
})

describe('readNodeResource', () => {
  it('returns node attrs and outbound edges as JSON', async () => {
    const { client, capture } = clientFor({
      '/graph/node/service:service-b': {
        node: {
          id: 'service:service-b',
          type: NodeType.ServiceNode,
          name: 'service-b',
          language: 'javascript',
          dependencies: { pg: '7.4.0' },
        },
      },
      '/graph/edges/service:service-b': {
        inbound: [],
        outbound: [
          {
            id: 'CONNECTS_TO:EXTRACTED:service:service-b->database:payments-db',
            source: 'service:service-b',
            target: 'database:payments-db',
            type: EdgeType.CONNECTS_TO,
            provenance: Provenance.EXTRACTED,
          },
        ],
      },
    })
    const result = await readNodeResource(client, 'service:service-b')
    expect(result.contents).toHaveLength(1)
    const c = result.contents[0]
    expect(c.uri).toBe('neat://node/service%3Aservice-b')
    expect(c.mimeType).toBe('application/json')
    const body = JSON.parse(c.text as string)
    expect(body.node.id).toBe('service:service-b')
    expect(body.node.dependencies.pg).toBe('7.4.0')
    expect(body.outboundEdges).toHaveLength(1)
    expect(body.outboundEdges[0].target).toBe('database:payments-db')
    expect(capture.paths).toContain('/graph/node/service%3Aservice-b')
    expect(capture.paths).toContain('/graph/edges/service%3Aservice-b')
  })

  it('returns a JSON error body when the node is missing instead of throwing', async () => {
    const { client } = clientFor({})
    const result = await readNodeResource(client, 'service:missing')
    const body = JSON.parse(result.contents[0].text as string)
    expect(body.error).toBe('node not found')
    expect(body.id).toBe('service:missing')
  })
})

describe('readRecentIncidentsResource', () => {
  it('returns events newest-first with count and total', async () => {
    const events = [
      {
        id: 'e1',
        timestamp: '2026-05-01T10:00:00Z',
        service: 'service-b',
        traceId: 't1',
        spanId: 's1',
        errorMessage: 'timeout',
      },
      {
        id: 'e2',
        timestamp: '2026-05-01T11:00:00Z',
        service: 'service-b',
        traceId: 't2',
        spanId: 's2',
        errorMessage: 'scram failure',
      },
    ]
    const { client } = clientFor({
      '/incidents': { count: events.length, total: events.length, events },
    })
    const result = await readRecentIncidentsResource(client)
    expect(result.contents).toHaveLength(1)
    const body = JSON.parse(result.contents[0].text as string)
    expect(body.total).toBe(2)
    expect(body.count).toBe(2)
    // Reversed → newest leads.
    expect(body.events[0].id).toBe('e2')
    expect(body.events[1].id).toBe('e1')
  })

  it('honours the limit', async () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      id: `e${i}`,
      timestamp: `2026-05-01T${String(i).padStart(2, '0')}:00:00Z`,
      service: 'svc',
      traceId: 't',
      spanId: 's',
      errorMessage: 'boom',
    }))
    const { client } = clientFor({
      '/incidents': { count: events.length, total: events.length, events },
    })
    const result = await readRecentIncidentsResource(client, 5)
    const body = JSON.parse(result.contents[0].text as string)
    expect(body.count).toBe(5)
    expect(body.total).toBe(100)
    expect(body.events[0].id).toBe('e99')
  })
})

describe('incidentsChanged', () => {
  it('returns false on the first observation (seeds, does not notify)', () => {
    expect(incidentsChanged(null, { total: 5, lastId: 'e5' })).toBe(false)
  })

  it('detects total count change', () => {
    expect(
      incidentsChanged({ total: 5, lastId: 'e5' }, { total: 6, lastId: 'e6' }),
    ).toBe(true)
  })

  it('detects last-id change even when total is unchanged', () => {
    // Same total but a different newest event — could happen if a delete +
    // insert raced. Rare but cheap to handle.
    expect(
      incidentsChanged({ total: 5, lastId: 'e5' }, { total: 5, lastId: 'e6' }),
    ).toBe(true)
  })

  it('returns false when nothing changed', () => {
    expect(
      incidentsChanged({ total: 5, lastId: 'e5' }, { total: 5, lastId: 'e5' }),
    ).toBe(false)
  })
})

describe('readStatusResource (neat://status, project-identity.md §6)', () => {
  const LINE = 'project=newdryve (prj_01JB) · binding=local · daemon=http://localhost:8080'

  it('serves the binding line and reports the daemon reachable when /health answers', async () => {
    const { client, capture } = clientFor({ '/health': { ok: true } })
    const result = await readStatusResource(client, LINE)
    expect(result.contents[0].uri).toBe('neat://status')
    expect(result.contents[0].mimeType).toBe('text/plain')
    expect(result.contents[0].text).toContain(LINE)
    expect(result.contents[0].text).toContain('daemon: reachable')
    expect(capture.paths).toContain('/health')
  })

  it('reports the daemon unreachable with the status when /health throws', async () => {
    const { client } = clientFor({}) // no /health in the map → HttpError 404
    const text = (await readStatusResource(client, LINE)).contents[0].text
    expect(text).toContain(LINE)
    expect(text).toContain('daemon: unreachable (HTTP 404)')
  })

  it('renders an explicit placeholder when the binding line is unresolved', async () => {
    const { client } = clientFor({ '/health': { ok: true } })
    const text = (await readStatusResource(client, undefined)).contents[0].text
    expect(text).toContain('project=<unresolved>')
    expect(text).toContain('daemon: reachable')
  })

  it('probes the project-scoped /health when a project is set', async () => {
    const { client, capture } = clientFor({ '/projects/shop/health': { ok: true } })
    await readStatusResource(client, LINE, 'shop')
    expect(capture.paths).toContain('/projects/shop/health')
  })
})
