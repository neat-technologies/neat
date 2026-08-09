import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Parser from 'tree-sitter'
import Php from 'tree-sitter-php'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { laravelRoutesFromSource, normalizePathTemplate } from '../src/extract/routes.js'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  routeId,
  serviceId,
} from '@neat.is/types'

// ADR-177 — PHP/Laravel route extraction, the first rung of the PHP pilot. The
// recogniser reads routes/web.php + routes/api.php and reimplements Laravel's
// resourceful expansion and group-prefix composition, so a declared route lands
// on the same RouteNode a Laravel server span (whose `http.route` is the
// templated URI) fuses onto. api.php routes get the framework's automatic `/api`
// prefix.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'php-laravel-baseline')

function phpParser(): Parser {
  const p = new Parser()
  p.setLanguage(Php.php_only)
  return p
}

// Render each extracted route as a `METHOD /template` tuple — the exact grain
// the assertions read. `basePrefix` is the file's automatic prefix ('' for
// web.php, '/api' for api.php).
function tuples(source: string, basePrefix = ''): string[] {
  return laravelRoutesFromSource(source, phpParser(), basePrefix).map(
    (r) => `${r.method} ${r.pathTemplate}`,
  )
}

const webPhp = readFileSync(path.join(FIXTURE, 'routes', 'web.php'), 'utf8')
const apiPhp = readFileSync(path.join(FIXTURE, 'routes', 'api.php'), 'utf8')

describe('laravelRoutesFromSource — web.php (ADR-177)', () => {
  const got = tuples(webPhp)

  it('reads the root route and explicit verb routes with a {id} param', () => {
    expect(got).toContain('GET /')
    expect(got).toContain('GET /orders/{id}')
    expect(got).toContain('POST /orders')
    expect(got).toContain('PUT /orders/{id}')
    expect(got).toContain('PATCH /orders/{id}')
    expect(got).toContain('DELETE /orders/{id}')
  })

  it('keeps an optional param readable and ignores a ->where() constraint', () => {
    // `{id?}` keeps its braces (the `?` is dropped); `->where(...)` and `->name(...)`
    // chained after the verb don't change the template.
    expect(got).toContain('GET /users/{id}')
    expect(got.some((t) => t.includes('{id?}'))).toBe(false)
    expect(got.some((t) => t.includes('/users/{id'))).toBe(true)
  })

  it('expands `Route::resource` to all seven rows, update on both PUT and PATCH', () => {
    expect(got).toContain('GET /photos')
    expect(got).toContain('GET /photos/create')
    expect(got).toContain('POST /photos')
    expect(got).toContain('GET /photos/{photo}')
    expect(got).toContain('GET /photos/{photo}/edit')
    expect(got).toContain('PUT /photos/{photo}')
    expect(got).toContain('PATCH /photos/{photo}')
    expect(got).toContain('DELETE /photos/{photo}')
    // The resource param is the singularized name.
    expect(got.some((t) => t.includes('/photos/{photos}'))).toBe(false)
  })

  it('composes nested prefix groups; name/controller groups leave the path unchanged', () => {
    // `prefix('admin')->name('admin.')` contributes only `/admin`; the nested
    // `prefix('reports')` composes onto it.
    expect(got).toContain('GET /admin/dashboard')
    expect(got).toContain('GET /admin/reports/monthly')
    // A `controller(...)->group(fn () => ...)` contributes no path segment.
    expect(got).toContain('GET /health')
    // No `admin.` name prefix leaked into the URL.
    expect(got.some((t) => t.includes('admin.'))).toBe(false)
  })

  it('composes a nested resource name into a nested path (best-effort)', () => {
    expect(got).toContain('GET /photos/{photo}/comments')
    expect(got).toContain('GET /photos/{photo}/comments/create')
    expect(got).toContain('POST /photos/{photo}/comments')
    expect(got).toContain('GET /photos/{photo}/comments/{comment}')
    expect(got).toContain('GET /photos/{photo}/comments/{comment}/edit')
    expect(got).toContain('PUT /photos/{photo}/comments/{comment}')
    expect(got).toContain('PATCH /photos/{photo}/comments/{comment}')
    expect(got).toContain('DELETE /photos/{photo}/comments/{comment}')
  })
})

describe('laravelRoutesFromSource — api.php automatic /api prefix (ADR-177)', () => {
  const got = tuples(apiPhp, '/api')

  it('prepends /api to every route in api.php', () => {
    expect(got).toContain('GET /api/orders/{id}')
    expect(got).toContain('POST /api/orders')
    // A group prefix composes after the automatic /api.
    expect(got).toContain('GET /api/v1/status')
    // Nothing escaped the prefix.
    expect(got.every((t) => t.split(' ')[1]!.startsWith('/api'))).toBe(true)
  })

  it('expands `Route::apiResource` to five rows — no create, no edit', () => {
    expect(got).toContain('GET /api/photos')
    expect(got).toContain('POST /api/photos')
    expect(got).toContain('GET /api/photos/{photo}')
    expect(got).toContain('PUT /api/photos/{photo}')
    expect(got).toContain('PATCH /api/photos/{photo}')
    expect(got).toContain('DELETE /api/photos/{photo}')
    // The two form-rendering GETs are dropped for an API resource.
    expect(got.some((t) => t === 'GET /api/photos/create')).toBe(false)
    expect(got.some((t) => t.endsWith('/edit'))).toBe(false)
  })
})

describe('Laravel route template fusion alignment (ADR-177)', () => {
  it('a resource template reduces to the same key Laravel OTel http.route does', () => {
    // Laravel's instrumentation sets http.route to the templated URI with no
    // leading slash (`api/photos/{photo}`); normalizePathTemplate drops the
    // leading slash and collapses every `{…}` segment to `:param` on both sides,
    // and the param name never matters.
    expect(normalizePathTemplate('/api/photos/{photo}')).toBe('/api/photos/:param')
    expect(normalizePathTemplate('/api/photos/{photo}')).toBe(
      normalizePathTemplate('api/photos/{order}'),
    )
    expect(normalizePathTemplate('/orders/{id}')).toBe(normalizePathTemplate('orders/42'))
  })
})

// End-to-end: composer.json discovers a Laravel service, the grammar loads, and
// the routes materialize as RouteNodes owned by the service — the shape a Laravel
// server span fuses onto.
describe('Laravel route extraction end-to-end (ADR-177)', () => {
  beforeEach(() => resetGraph())

  it('discovers the Laravel service and materializes the route files as RouteNodes', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, FIXTURE)
    expect(result.extractionErrors).toBe(0)

    const svc = serviceId('php-laravel-baseline')
    expect(graph.hasNode(svc)).toBe(true)
    expect((graph.getNodeAttributes(svc) as { language: string }).language).toBe('php')
    expect((graph.getNodeAttributes(svc) as { framework?: string }).framework).toBe('laravel')

    const show = routeId('php-laravel-baseline', 'GET', '/orders/{id}')
    expect(graph.hasNode(show)).toBe(true)
    const node = graph.getNodeAttributes(show) as RouteNode
    expect(node.type).toBe(NodeType.RouteNode)
    expect(node.method).toBe('GET')
    expect(node.pathTemplate).toBe('/orders/{id}')
    expect(node.framework).toBe('laravel')
    expect(node.path).toBe('routes/web.php')

    // resource update lands on both verbs; the api.php routes carry the /api prefix.
    expect(graph.hasNode(routeId('php-laravel-baseline', 'PUT', '/photos/{photo}'))).toBe(true)
    expect(graph.hasNode(routeId('php-laravel-baseline', 'PATCH', '/photos/{photo}'))).toBe(true)
    expect(graph.hasNode(routeId('php-laravel-baseline', 'GET', '/api/photos'))).toBe(true)
    expect(graph.hasNode(routeId('php-laravel-baseline', 'GET', '/api/v1/status'))).toBe(true)
    expect(graph.hasNode(routeId('php-laravel-baseline', 'GET', '/'))).toBe(true)
    // apiResource dropped create; that node was never minted.
    expect(graph.hasNode(routeId('php-laravel-baseline', 'GET', '/api/photos/create'))).toBe(false)

    // The service owns its routes through a CONTAINS edge pinned to the route file.
    const containsId = extractedEdgeId(svc, show, EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe('routes/web.php')
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
