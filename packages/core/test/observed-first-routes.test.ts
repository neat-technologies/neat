import { describe, it, expect, beforeEach } from 'vitest'
import { EdgeType, NodeType, Provenance, routeId, serviceId, type GraphEdge, type RouteNode } from '@neat.is/types'
import { resetGraph, getGraph } from '../src/graph.js'
import { parseOtlpRequest, type OtlpTracesRequest } from '../src/otel.js'
import { handleSpan, resetParentSpanCache, type IngestContext } from '../src/ingest.js'
import { upsertRouteNode } from '../src/extract/route-node.js'

// A served route no extractor declared mints an observed-first RouteNode
// (ADR-275). Span shapes are Gitea v28.3.0's under otelc plus NEAT's chi rule:
// `http.route` is the joined chi template, `code.*` the registration frame.

let n = 0
function serverSpan(service: string, attrs: Record<string, string | number>): OtlpTracesRequest {
  n++
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'aabbccddeeff00112233445566778899',
                spanId: n.toString(16).padStart(16, '0'),
                name: 'GET',
                kind: 2,
                startTimeUnixNano: '1000000000000000000',
                endTimeUnixNano: '1000000000050000000',
                attributes: Object.entries(attrs).map(([key, value]) => ({
                  key,
                  value: typeof value === 'number' ? { intValue: value } : { stringValue: value },
                })),
                status: { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  }
}
const gitea = (route: string | undefined, extra: Record<string, string | number> = {}) =>
  serverSpan('gitea', {
    'http.request.method': 'GET',
    'url.path': '/api/v1/repos/neat/demo/issues',
    ...(route ? { 'http.route': route } : {}),
    ...extra,
  })

const routes = () => {
  const out: RouteNode[] = []
  getGraph().forEachNode((_id, a) => {
    if ((a as RouteNode).type === NodeType.RouteNode) out.push(a as RouteNode)
  })
  return out
}
const observedContains = (target: string) =>
  getGraph()
    .inEdges(target)
    .map((e) => getGraph().getEdgeAttributes(e) as GraphEdge)
    .filter((e) => e.type === EdgeType.CONTAINS && e.provenance === Provenance.OBSERVED)

describe('observed-first routes (ADR-275)', () => {
  let ctx: IngestContext
  beforeEach(() => {
    resetGraph()
    resetParentSpanCache()
    ctx = { graph: getGraph() }
  })
  const ingest = async (req: OtlpTracesRequest) => {
    for (const s of parseOtlpRequest(req)) await handleSpan(ctx, s)
  }

  it('mints the route from the chi template, located at its registration frame', async () => {
    await ingest(
      gitea('/api/v1/repos/{username}/{reponame}/issues', {
        'code.filepath': 'routers/api/v1/api.go',
        'code.lineno': 1649,
      }),
    )
    const id = routeId('gitea', 'GET', '/api/v1/repos/{username}/{reponame}/issues')
    const node = getGraph().getNodeAttributes(id) as RouteNode
    expect(node).toMatchObject({ discoveredVia: 'otel', method: 'GET', service: 'gitea', line: 1649 })
    expect(node.path).toContain('api.go')
    expect(observedContains(id).map((e) => e.source)).toEqual([serviceId('gitea')])
  })

  it('leaves the location absent when the span names none', async () => {
    await ingest(gitea('/api/v1/version'))
    const node = getGraph().getNodeAttributes(routeId('gitea', 'GET', '/api/v1/version')) as RouteNode
    expect(node.path).toBeUndefined()
    expect(node.line).toBeUndefined()
  })

  it('is one node however many requests hit it', async () => {
    for (let i = 0; i < 3; i++) await ingest(gitea('/api/v1/repos/{username}/{reponame}'))
    expect(routes()).toHaveLength(1)
    expect(observedContains(routes()[0]!.id)[0]!.signal?.spanCount).toBe(3)
  })

  it('never mints from a concrete path', async () => {
    await ingest(gitea(undefined)) // url.path only, as Gitea emits without the chi rule
    await ingest(gitea('/api/v1/repos/42/issues')) // a concrete path in http.route
    await ingest(gitea('/files/3f2c9a1e-8b7d-4c6e-9f00-1a2b3c4d5e6f'))
    await ingest(gitea('/blob/5f9c2b8e1d3a4c6b7e8f9a0b'))
    expect(routes()).toEqual([])
  })

  it('needs a real HTTP method and a gRPC path is never a route', async () => {
    await ingest(serverSpan('gitea', { 'http.request.method': '_OTHER', 'http.route': '/x' }))
    await ingest(serverSpan('gitea', { 'http.route': '/y' }))
    await ingest(serverSpan('cart', { 'http.request.method': 'POST', 'http.route': '/oteldemo.CartService/AddItem' }))
    expect(routes()).toEqual([])
  })

  it('still fuses onto a declared route instead of minting a twin', async () => {
    const declared = routeId('gitea', 'GET', '/api/v1/users/:username/repos')
    getGraph().addNode(declared, {
      id: declared,
      type: NodeType.RouteNode,
      name: 'GET /api/v1/users/:username/repos',
      service: 'gitea',
      method: 'GET',
      pathTemplate: '/api/v1/users/:username/repos',
      path: 'routers/api/v1/api.go',
      discoveredVia: 'static',
    } as RouteNode)
    await ingest(gitea('/api/v1/users/{username}/repos'))
    expect(routes().map((r) => r.id)).toEqual([declared])
    expect(observedContains(declared)).toHaveLength(1)
  })

  it('a later extraction lands on the observed node and fills in the declaration', async () => {
    await ingest(gitea('/api/v1/version/'))
    const id = routeId('gitea', 'GET', '/api/v1/version') // trailing slash canonicalized
    expect(getGraph().hasNode(id)).toBe(true)
    const added = upsertRouteNode(getGraph(), {
      id,
      type: NodeType.RouteNode,
      name: 'GET /api/v1/version',
      service: 'gitea',
      method: 'GET',
      pathTemplate: '/api/v1/version',
      path: 'routers/api/v1/api.go',
      line: 1089,
      framework: 'chi',
      discoveredVia: 'static',
    })
    expect(added).toBe(false)
    expect(getGraph().getNodeAttributes(id)).toMatchObject({ discoveredVia: 'merged', line: 1089, framework: 'chi' })
    expect(observedContains(id)).toHaveLength(1)
  })
})
