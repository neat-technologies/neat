import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Parser from 'tree-sitter'
import Ruby from 'tree-sitter-ruby'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { sinatraRoutesFromSource, normalizePathTemplate } from '../src/extract/routes.js'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  routeId,
  serviceId,
} from '@neat.is/types'

// ADR-206 — Ruby/Sinatra route extraction. Our Ruby route recognizer was
// Rails-shaped (ADR-173, `config/routes.rb`) and missed Sinatra, whose routes are
// bare verb DSL calls carrying a string pattern and a block. The Rack / Sinatra
// OTel instrumentation sets `http.route` to the matched pattern, so a declared
// template lands on the same RouteNode a server span fuses onto through
// `normalizePathTemplate` with no ingest change.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'ruby-sinatra-baseline')

function rubyParser(): Parser {
  const p = new Parser()
  p.setLanguage(Ruby)
  return p
}

// Render each extracted route as a `METHOD /template` tuple, the grain the
// assertions read.
function tuples(source: string): string[] {
  return sinatraRoutesFromSource(source, rubyParser()).map((r) => `${r.method} ${r.pathTemplate}`)
}

const emailServerRb = readFileSync(path.join(FIXTURE, 'email_server.rb'), 'utf8')

describe('sinatraRoutesFromSource (ADR-206)', () => {
  const got = tuples(emailServerRb)

  it('reads the bare verb DSL routes, method from the verb', () => {
    expect(got).toContain('POST /send_order_confirmation')
    expect(got).toContain('GET /health')
    expect(got).toContain('GET /orders/:id')
  })

  it('ignores a receiver-ed verb call inside a route body', () => {
    // `logger.post('/audit')` has a receiver — it is not the DSL.
    expect(got.some((t) => t.includes('/audit'))).toBe(false)
    // Exactly the three routes above, nothing more.
    expect(got.length).toBe(3)
  })

  it('reads nothing from a file that does not reference Sinatra', () => {
    // The `lib/mailer.rb` guard file requires no sinatra and subclasses nothing —
    // its bare `post` word and receiver'd `get` mint no route.
    const mailer = readFileSync(path.join(FIXTURE, 'lib', 'mailer.rb'), 'utf8')
    expect(tuples(mailer)).toEqual([])
  })

  it('reads a modular `Sinatra::Base` app the same way', () => {
    const src = `class EmailApp < Sinatra::Base
  post '/send_order_confirmation' do
    status 200
  end
end`
    expect(tuples(src)).toEqual(['POST /send_order_confirmation'])
  })

  it('a template reduces to the same key a Sinatra http.route does', () => {
    expect(normalizePathTemplate('/orders/:id')).toBe('/orders/:param')
    expect(normalizePathTemplate('/orders/:id')).toBe(normalizePathTemplate('/orders/42'))
  })
})

// End-to-end: the Gemfile discovers a Sinatra service, the grammar loads, and the
// routes materialize as RouteNodes owned by the service — the shape a Sinatra
// server span fuses onto.
describe('Sinatra route extraction end-to-end (ADR-206)', () => {
  beforeEach(() => resetGraph())

  it('discovers the Sinatra service and materializes its routes as RouteNodes', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, FIXTURE)
    expect(result.extractionErrors).toBe(0)

    // Ruby services take the directory basename (extract/ruby.ts) — the fixture
    // stands in for the otel-demo `email` service.
    const svc = serviceId('ruby-sinatra-baseline')
    expect(graph.hasNode(svc)).toBe(true)
    expect((graph.getNodeAttributes(svc) as { language: string }).language).toBe('ruby')

    const confirm = routeId('ruby-sinatra-baseline', 'POST', '/send_order_confirmation')
    expect(graph.hasNode(confirm)).toBe(true)
    const node = graph.getNodeAttributes(confirm) as RouteNode
    expect(node.type).toBe(NodeType.RouteNode)
    expect(node.method).toBe('POST')
    expect(node.pathTemplate).toBe('/send_order_confirmation')
    expect(node.framework).toBe('sinatra')
    expect(node.path).toBe('email_server.rb')

    expect(graph.hasNode(routeId('ruby-sinatra-baseline', 'GET', '/health'))).toBe(true)
    expect(graph.hasNode(routeId('ruby-sinatra-baseline', 'GET', '/orders/:id'))).toBe(true)
    // The mailer guard file minted nothing.
    expect(graph.hasNode(routeId('ruby-sinatra-baseline', 'POST', '/smtp/send'))).toBe(false)

    // The service owns its routes through a CONTAINS edge pinned to the route file.
    const containsId = extractedEdgeId(svc, confirm, EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe('email_server.rb')
    expect(contains.evidence?.line).toBeGreaterThan(0)
  })

  it('is idempotent — a second pass adds no nodes or edges', async () => {
    const graph = getGraph()
    const first = await extractFromDirectory(graph, FIXTURE)
    const second = await extractFromDirectory(graph, FIXTURE)
    expect(first.nodesAdded).toBeGreaterThan(0)
    expect(second.nodesAdded).toBe(0)
    expect(second.edgesAdded).toBe(0)
  })
})
