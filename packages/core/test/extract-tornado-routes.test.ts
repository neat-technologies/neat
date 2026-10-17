import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Parser from 'tree-sitter'
import Python from 'tree-sitter-python'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { tornadoPathTemplate, tornadoRoutesFromSource } from '../src/extract/tornado-routes.js'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import { EdgeType, Provenance, extractedEdgeId, routeId, serviceId } from '@neat.is/types'

// Tornado routes: a literal handler table passed to `Application`. The fixture
// is train-ticket's ts-voucher-service.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'python-tornado-train-ticket')

function tuples(source: string): string[] {
  const p = new Parser()
  p.setLanguage(Python)
  return tornadoRoutesFromSource(source, p).map((r) => `${r.method} ${r.pathTemplate}`)
}

describe('tornadoPathTemplate', () => {
  it('turns capture groups into params and drops anchors', () => {
    expect(tornadoPathTemplate('/orders/(?P<id>[0-9]+)')).toBe('/orders/:id')
    expect(tornadoPathTemplate('^/items/([^/]+)/?$')).toBe('/items/:param')
    expect(tornadoPathTemplate('/static/.*')).toBeNull()
  })
})

describe('tornadoRoutesFromSource', () => {
  it('reads inline, handlers=, and variable tables, one route per defined verb', () => {
    expect(
      tuples(`
import tornado.web
from tornado.web import url

class Orders(tornado.web.RequestHandler):
    def get(self): pass
    def post(self): pass

class Health(tornado.web.RequestHandler):
    def get(self): pass

routes = [(r"/health", Health)]

def make():
    tornado.web.Application([(r"/orders/(?P<id>[0-9]+)", Orders), url(r"/elsewhere", imported.Handler, name="e")])
    tornado.web.Application(handlers=[(r"/orders", Orders)])
    return tornado.web.Application(routes)
`),
    ).toEqual([
      'GET /orders/:id',
      'POST /orders/:id',
      'ALL /elsewhere',
      'GET /orders',
      'POST /orders',
      'GET /health',
    ])
  })

  it('leaves a computed or regex-shaped pattern unclaimed', () => {
    expect(
      tuples(`
import tornado.web
tornado.web.Application([(PREFIX + "/x", H), (f"/{name}", H), (r"/files/.*", H)])
`),
    ).toEqual([])
  })
})

describe('Tornado routes from train-ticket (extractFromDirectory)', () => {
  beforeAll(async () => {
    resetGraph()
    await extractFromDirectory(getGraph(), FIXTURE, { announce: false })
  })

  it("mints voucher's /getVoucher route from the handler's post method", () => {
    const rid = routeId('ts-voucher-service', 'POST', '/getVoucher')
    expect(getGraph().getNodeAttributes(rid) as RouteNode).toMatchObject({
      framework: 'tornado',
      path: 'server.py',
      line: 101,
    })
    const edge = getGraph().getEdgeAttributes(
      extractedEdgeId(serviceId('ts-voucher-service'), rid, EdgeType.CONTAINS),
    ) as GraphEdge
    expect(edge.provenance).toBe(Provenance.EXTRACTED)
  })
})
