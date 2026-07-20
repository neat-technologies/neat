import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { fileId, NodeType } from '@neat.is/types'
import { resetGraph, getGraph } from '../src/graph.js'
import { buildApi } from '../src/api.js'

// A daemon that can't be addressed can't be debugged. Under file-awareness
// (ADR-087) a node id is `file:<service>:<relPath>` (or `code:<file>:<symbol>`),
// which the CLI and MCP clients URL-encode (every `/` → `%2F`) before it lands
// in a `:id` / `:nodeId` path param. Fastify's default maxParamLength of 100
// then rejects any realistic file-grained id at the router — before the handler
// runs — with a generic `{ message: 'Route ... not found' }` 404. To an agent
// asking for a node's blast radius or dependencies, that reads as a broken
// endpoint rather than "that node isn't in the graph," and there's no path to
// recovery. buildApi raises the cap so a long-but-real id reaches the handler.
//
// This is the resilience/self-debuggability guard for issue #818's gate item:
// a long node id must resolve (or return the handler's actionable not-found
// shape), never the router's misleading route-not-found.
describe('REST API — long file-grained node ids reach the handler (maxParamLength)', () => {
  let app: FastifyInstance

  // A realistic file-grained id: a deep monorepo path. Comfortably past the
  // 100-char Fastify default once the `file:` prefix and service segment are
  // counted, and longer still after the client url-encodes the slashes.
  const longRelPath =
    'packages/core/src/connectors/providers/cloudflare/analytics-engine-binding-extractor.ts'
  const longNodeId = fileId('my-really-long-service-name', longRelPath)

  beforeEach(async () => {
    resetGraph()
    const graph = getGraph()
    graph.addNode(longNodeId, {
      id: longNodeId,
      type: NodeType.FileNode,
      service: 'my-really-long-service-name',
      path: longRelPath,
    })
    app = await buildApi({ graph })
  })

  afterEach(async () => {
    await app.close()
  })

  it('the id is long enough to trip the Fastify default (sanity)', () => {
    // Guards the test itself: if the id ever shrank under 100 chars the test
    // would pass trivially against the old default and prove nothing.
    expect(encodeURIComponent(longNodeId).length).toBeGreaterThan(100)
  })

  it('GET /graph/node/:id resolves a long, url-encoded file id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/graph/node/${encodeURIComponent(longNodeId)}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().node).toMatchObject({ id: longNodeId, type: NodeType.FileNode })
  })

  it('an unknown long id returns the handler not-found shape, not the router 404', async () => {
    const missing = fileId('another-long-service', `${longRelPath}.does-not-exist`)
    const res = await app.inject({
      method: 'GET',
      url: `/graph/node/${encodeURIComponent(missing)}`,
    })
    // The request reached the handler — which answers with an id an agent can
    // act on — rather than being rejected by find-my-way with a bare
    // `{ message: 'Route ... not found' }` that reads as a missing endpoint.
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'node not found', id: missing })
  })

  it('blast-radius and dependencies also address a long id via the handler', async () => {
    const missing = fileId('svc', `${longRelPath}.nope`)
    for (const route of ['/graph/blast-radius/', '/graph/dependencies/']) {
      const res = await app.inject({
        method: 'GET',
        url: `${route}${encodeURIComponent(missing)}`,
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ error: 'node not found' })
    }
  })
})
