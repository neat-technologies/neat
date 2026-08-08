import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Parser from 'tree-sitter'
import Ruby from 'tree-sitter-ruby'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { railsRoutesFromSource, normalizePathTemplate } from '../src/extract/routes.js'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  routeId,
  serviceId,
} from '@neat.is/types'

// ADR-173 — Ruby/Rails route extraction, the first rung of the Ruby pilot. The
// recogniser reimplements Rails' resourceful expansion so a `config/routes.rb`
// route lands on the same RouteNode a Rails action_pack server span (whose
// `http.route` is the `:id`-form template with `(.:format)` stripped) fuses onto.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'ruby-rails-baseline')

function rubyParser(): Parser {
  const p = new Parser()
  p.setLanguage(Ruby)
  return p
}

// Render each extracted route as a `METHOD /template -> controller#action`
// tuple, the exact grain the assertions read.
function tuples(source: string): string[] {
  return railsRoutesFromSource(source, rubyParser()).map(
    (r) => `${r.method} ${r.pathTemplate}${r.controller ? ` -> ${r.controller}` : ''}`,
  )
}

const routesRb = readFileSync(path.join(FIXTURE, 'config', 'routes.rb'), 'utf8')

describe('railsRoutesFromSource (ADR-173)', () => {
  const got = tuples(routesRb)

  it('reads root and explicit verb routes (to:, hash-rocket, and bare inference)', () => {
    expect(got).toContain('GET / -> pages#main')
    expect(got).toContain('GET /about -> pages#about')
    expect(got).toContain('POST /contact -> pages#contact')
    // Bare `get 'status'` with no `to:` infers `status#index`.
    expect(got).toContain('GET /status -> status#index')
  })

  it('expands `resources` to all seven rows, update on both PATCH and PUT', () => {
    expect(got).toContain('GET /orders -> orders#index')
    expect(got).toContain('GET /orders/new -> orders#new')
    expect(got).toContain('POST /orders -> orders#create')
    expect(got).toContain('GET /orders/:id -> orders#show')
    expect(got).toContain('GET /orders/:id/edit -> orders#edit')
    expect(got).toContain('PATCH /orders/:id -> orders#update')
    expect(got).toContain('PUT /orders/:id -> orders#update')
    expect(got).toContain('DELETE /orders/:id -> orders#destroy')
  })

  it('adds member and collection routes to the enclosing resource', () => {
    expect(got).toContain('GET /orders/:id/preview -> orders#preview')
    expect(got).toContain('GET /orders/search -> orders#search')
  })

  it('expands singular `resource` with a pluralized controller and no :id', () => {
    expect(got).toContain('GET /profile/new -> profiles#new')
    expect(got).toContain('POST /profile -> profiles#create')
    expect(got).toContain('GET /profile -> profiles#show')
    expect(got).toContain('GET /profile/edit -> profiles#edit')
    expect(got).toContain('PATCH /profile -> profiles#update')
    expect(got).toContain('PUT /profile -> profiles#update')
    expect(got).toContain('DELETE /profile -> profiles#destroy')
    // No index route and no :id member for a singular resource.
    expect(got).not.toContain('GET /profile -> profiles#index')
    expect(got.some((t) => t.includes('/profile/:id'))).toBe(false)
  })

  it('namespace contributes both a path prefix and a controller module prefix', () => {
    expect(got).toContain('GET /admin/articles -> admin/articles#index')
    expect(got).toContain('GET /admin/articles/:id -> admin/articles#show')
    expect(got).toContain('PATCH /admin/articles/:id -> admin/articles#update')
    expect(got).toContain('PUT /admin/articles/:id -> admin/articles#update')
    expect(got).toContain('DELETE /admin/articles/:id -> admin/articles#destroy')
  })

  it('scope with a path only prefixes the URL, not the controller module', () => {
    expect(got).toContain('GET /legacy/widgets -> widgets#index')
    expect(got).toContain('GET /legacy/widgets/:id -> widgets#show')
    // only: [:index, :show] — no create/update/destroy.
    expect(got.some((t) => t.startsWith('POST /legacy/widgets'))).toBe(false)
    expect(got.some((t) => t.startsWith('DELETE /legacy/widgets'))).toBe(false)
  })

  it('scope with a module only shifts the controller, leaving the URL unchanged', () => {
    // The path carries no `/internal` — only the controller module differs, the
    // one case the path template alone can't distinguish.
    expect(got).toContain('GET /metrics -> internal/metrics#index')
    expect(got).toContain('GET /metrics/:id -> internal/metrics#show')
    expect(got).toContain('PATCH /metrics/:id -> internal/metrics#update')
    // except: :destroy — no DELETE row.
    expect(got.some((t) => t.startsWith('DELETE /metrics'))).toBe(false)
    // No `/internal` path prefix was fabricated.
    expect(got.some((t) => t.includes('/internal/metrics'))).toBe(false)
  })

  it('scope with both path and module prefixes each axis', () => {
    expect(got).toContain('GET /v2/gadgets -> v2/gadgets#index')
    // only: [:index] — nothing else.
    expect(got.filter((t) => t.includes('/v2/gadgets')).length).toBe(1)
  })

  it('composes one level of nesting with the parent `:<singular>_id` param', () => {
    expect(got).toContain('GET /magazines/:magazine_id/ads -> ads#index')
    expect(got).toContain('POST /magazines/:magazine_id/ads -> ads#create')
    expect(got).toContain('GET /magazines/:magazine_id/ads/:id -> ads#show')
    expect(got).toContain('GET /magazines/:magazine_id/ads/:id/edit -> ads#edit')
    expect(got).toContain('PATCH /magazines/:magazine_id/ads/:id -> ads#update')
    expect(got).toContain('PUT /magazines/:magazine_id/ads/:id -> ads#update')
    expect(got).toContain('DELETE /magazines/:magazine_id/ads/:id -> ads#destroy')
    // The parent's own routes stand at their own grain.
    expect(got).toContain('GET /magazines/:id -> magazines#show')
  })

  it('defers a mounted engine rather than fabricating a route', () => {
    expect(got.some((t) => t.includes('/sidekiq'))).toBe(false)
  })

  it('a nested `:magazine_id` route reduces to the same key an OTel http.route does', () => {
    // Rails action_pack sets http.route to `/magazines/:magazine_id/ads/:id`;
    // normalizePathTemplate collapses every `:word` to `:param` on both sides.
    expect(normalizePathTemplate('/magazines/:magazine_id/ads/:id')).toBe('/magazines/:param/ads/:param')
    expect(normalizePathTemplate('/magazines/:magazine_id/ads/:id')).toBe(
      normalizePathTemplate('/magazines/42/ads/7'),
    )
  })
})

// End-to-end: the Gemfile discovers a Rails service, the grammar loads, and the
// routes materialize as RouteNodes owned by the service — the shape a Rails
// server span fuses onto.
describe('Rails route extraction end-to-end (ADR-173)', () => {
  beforeEach(() => resetGraph())

  it('discovers the Rails service and materializes routes.rb as RouteNodes', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, FIXTURE)
    expect(result.extractionErrors).toBe(0)

    const svc = serviceId('ruby-rails-baseline')
    expect(graph.hasNode(svc)).toBe(true)
    expect((graph.getNodeAttributes(svc) as { language: string }).language).toBe('ruby')
    expect((graph.getNodeAttributes(svc) as { framework?: string }).framework).toBe('rails')

    const show = routeId('ruby-rails-baseline', 'GET', '/orders/:id')
    expect(graph.hasNode(show)).toBe(true)
    const node = graph.getNodeAttributes(show) as RouteNode
    expect(node.type).toBe(NodeType.RouteNode)
    expect(node.method).toBe('GET')
    expect(node.pathTemplate).toBe('/orders/:id')
    expect(node.framework).toBe('rails')
    expect(node.path).toBe('config/routes.rb')

    // update lands on both verbs; the nested + module-only-scope routes land too.
    expect(graph.hasNode(routeId('ruby-rails-baseline', 'PATCH', '/orders/:id'))).toBe(true)
    expect(graph.hasNode(routeId('ruby-rails-baseline', 'PUT', '/orders/:id'))).toBe(true)
    expect(graph.hasNode(routeId('ruby-rails-baseline', 'GET', '/magazines/:magazine_id/ads/:id'))).toBe(true)
    expect(graph.hasNode(routeId('ruby-rails-baseline', 'GET', '/metrics'))).toBe(true)
    expect(graph.hasNode(routeId('ruby-rails-baseline', 'GET', '/'))).toBe(true)

    // The service owns its routes through a CONTAINS edge pinned to routes.rb.
    const containsId = extractedEdgeId(svc, show, EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe('config/routes.rb')
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
