import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MultiDirectedGraph } from 'graphology'
import { EdgeType, NodeType, type GraphEdge, type GraphNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import { parseOtlpRequest } from '../src/otel.js'

// #1424 — DeathStarBench socialNetwork through SREGym's collector. Every span comes
// from an OpenTracing client (Jaeger C++, nginx-opentracing) and has no kind. The
// C++ Thrift spans carry no attributes, only a name and a parent; nginx's request
// span carries `http.url` at its own Service ClusterIP and `peer.address` naming the
// client. Shapes below are taken from the capture.

const TRACE = '5b8efff798038103d269b633813fc60c'

type Attr = { key: string; value: { stringValue?: string; intValue?: string } }
function str(key: string, v: string): Attr {
  return { key, value: { stringValue: v } }
}
function otlp(service: string, span: { spanId: string; parentSpanId?: string; name: string; kind?: number; attributes?: Attr[] }) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [str('service.name', service), str('opencensus.exporterversion', 'Jaeger-C++-0.4.2')] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                ...(span.kind !== undefined ? { kind: span.kind } : {}),
                startTimeUnixNano: '1760655020000000000',
                endTimeUnixNano: '1760655020002000000',
                attributes: span.attributes ?? [],
                status: {},
              },
            ],
          },
        ],
      },
    ],
  }
}

const NGINX_REQUEST = [
  str('http.method', 'GET'),
  str('http.url', 'http://10.96.98.169:8080/wrk2-api/home-timeline/read?user_id=12'),
  str('http.host', '10.96.98.169:8080'),
  str('peer.address', '10.244.110.167:45220'),
  { key: 'http.status_code', value: { intValue: '200' } },
]

function frontierNodes(g: NeatGraph): string[] {
  return g.filterNodes((_id, a) => (a as GraphNode).type === NodeType.FrontierNode)
}
function callsEdges(g: NeatGraph): string[] {
  return g
    .filterEdges((_e, a) => (a as GraphEdge).type === EdgeType.CALLS)
    .map((e) => {
      const a = g.getEdgeAttributes(e) as GraphEdge
      return `${a.source}->${a.target}`
    })
    .sort()
}

describe('spans with no kind (#1424)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-kindless-'))
    const graph: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    ctx = { graph, errorsPath: path.join(tmpDir, 'errors.ndjson') }
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function ingest(service: string, span: Parameters<typeof otlp>[1]): Promise<void> {
    for (const s of parseOtlpRequest(otlp(service, span))) await handleSpan(ctx, s)
  }

  it("nginx's request span does not read its own URL as a callee", async () => {
    await ingest('nginx-web-server', { spanId: 'a000000000000001', name: '/wrk2-api/home-timeline/read', attributes: NGINX_REQUEST })
    await ingest('nginx-web-server', {
      spanId: 'a000000000000002',
      parentSpanId: 'a000000000000001',
      name: '/wrk2-api/home-timeline/read',
      attributes: NGINX_REQUEST,
    })
    expect(frontierNodes(ctx.graph)).toEqual([])
    expect(callsEdges(ctx.graph)).toEqual([])
  })

  it('a Thrift child with no attributes joins its parent across services', async () => {
    await ingest('nginx-web-server', { spanId: 'a000000000000001', name: '/wrk2-api/home-timeline/read', attributes: NGINX_REQUEST })
    await ingest('nginx-web-server', { spanId: 'a000000000000003', parentSpanId: 'a000000000000001', name: 'read_home_timeline_client' })
    await ingest('home-timeline-service', {
      spanId: 'b000000000000001',
      parentSpanId: 'a000000000000003',
      name: 'read_home_timeline_server',
    })
    expect(callsEdges(ctx.graph)).toEqual(['service:nginx-web-server->service:home-timeline-service'])
    expect(frontierNodes(ctx.graph)).toEqual([])
  })

  it('a Thrift child whose parent never arrived mints nothing', async () => {
    await ingest('user-service', { spanId: 'c000000000000001', parentSpanId: 'ffffffffffffffff', name: 'compose_creator_server' })
    expect(callsEdges(ctx.graph)).toEqual([])
    expect(frontierNodes(ctx.graph)).toEqual([])
  })

  it('a span with no kind still mints from a peer attribute', async () => {
    await ingest('checkout', { spanId: 'd000000000000001', name: 'call', attributes: [str('server.address', 'payments-api.internal')] })
    expect(callsEdges(ctx.graph)).toEqual(['service:checkout->frontier:payments-api.internal'])
  })

  it('a CLIENT span still reads its URL host as the callee', async () => {
    await ingest('frontend', {
      spanId: 'e000000000000001',
      name: 'GET',
      kind: 3,
      attributes: [str('http.url', 'http://catalog.internal:8080/products')],
    })
    expect(callsEdges(ctx.graph)).toEqual(['service:frontend->frontier:catalog.internal'])
  })
})
