import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Parser from 'tree-sitter'
import Php from 'tree-sitter-php'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { slimRoutesFromSource, normalizePathTemplate } from '../src/extract/routes.js'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  routeId,
  serviceId,
} from '@neat.is/types'

// ADR-206 — PHP/Slim route extraction. Our PHP route recognizer was Laravel-shaped
// (ADR-177) and missed Slim, whose routes live on a `$app` value rather than the
// `Route` facade in conventional files. Slim declares `$app->post('/getquote', …)`,
// `$app->map([...], '/x', …)`, and `$app->group('/prefix', fn)` groups; the Slim
// OTel instrumentation sets `http.route` to the matched pattern, so a declared
// template lands on the same RouteNode a server span fuses onto through
// `normalizePathTemplate` with no ingest change.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'php-slim-baseline')

function phpParser(): Parser {
  const p = new Parser()
  p.setLanguage(Php.php_only)
  return p
}

// Render each extracted route as a `METHOD /template` tuple, the grain the
// assertions read.
function tuples(source: string): string[] {
  return slimRoutesFromSource(source, phpParser()).map((r) => `${r.method} ${r.pathTemplate}`)
}

const indexPhp = readFileSync(path.join(FIXTURE, 'public', 'index.php'), 'utf8')

describe('slimRoutesFromSource (ADR-206)', () => {
  const got = tuples(indexPhp)

  it('reads the verb routes off the Slim App value, method from the verb', () => {
    expect(got).toContain('POST /getquote')
    // A `->setName(...)` chained after the verb doesn't change the template.
    expect(got).toContain('GET /health')
  })

  it('fans `->map([...], path, ...)` out to one route per listed method', () => {
    expect(got).toContain('GET /echo')
    expect(got).toContain('POST /echo')
  })

  it('maps the method-agnostic `->any(...)` to ALL', () => {
    expect(got).toContain('ALL /any')
  })

  it('composes a group prefix, and a nested group composes again', () => {
    expect(got).toContain('GET /api/status')
    expect(got).toContain('POST /api/v1/orders')
  })

  it('reads a `.get()` only on a Slim App value, never an arbitrary object', () => {
    // A file that constructs no Slim App has no app var, so a `$cache->get(...)`
    // mints nothing.
    const cache = readFileSync(path.join(FIXTURE, 'src', 'Cache.php'), 'utf8')
    expect(tuples(cache)).toEqual([])
    // Exactly the seven routes above, nothing more (no `run`/`setName` phantom).
    expect(got.length).toBe(7)
  })

  it('a group template reduces to the same key a Slim http.route does', () => {
    const src = `<?php
use Slim\\Factory\\AppFactory;
$app = AppFactory::create();
$app->group('/users', function ($g) {
    $g->get('/{id}', function ($req, $res) { return $res; });
});`
    expect(tuples(src)).toEqual(['GET /users/{id}'])
    expect(normalizePathTemplate('/users/{id}')).toBe('/users/:param')
    expect(normalizePathTemplate('/users/{id}')).toBe(normalizePathTemplate('/users/42'))
  })
})

// End-to-end: composer.json discovers a Slim service, the grammar loads, and the
// routes materialize as RouteNodes owned by the service — the shape a Slim server
// span fuses onto.
describe('Slim route extraction end-to-end (ADR-206)', () => {
  beforeEach(() => resetGraph())

  it('discovers the Slim service and materializes its routes as RouteNodes', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, FIXTURE)
    expect(result.extractionErrors).toBe(0)

    // PHP services take the directory basename (extract/php.ts), like the Laravel
    // reader — the fixture stands in for the otel-demo `quote` service.
    const svc = serviceId('php-slim-baseline')
    expect(graph.hasNode(svc)).toBe(true)
    expect((graph.getNodeAttributes(svc) as { language: string }).language).toBe('php')

    const getquote = routeId('php-slim-baseline', 'POST', '/getquote')
    expect(graph.hasNode(getquote)).toBe(true)
    const node = graph.getNodeAttributes(getquote) as RouteNode
    expect(node.type).toBe(NodeType.RouteNode)
    expect(node.method).toBe('POST')
    expect(node.pathTemplate).toBe('/getquote')
    expect(node.framework).toBe('slim')
    expect(node.path).toBe('public/index.php')

    // The group-composed and map routes land too.
    expect(graph.hasNode(routeId('php-slim-baseline', 'GET', '/api/status'))).toBe(true)
    expect(graph.hasNode(routeId('php-slim-baseline', 'POST', '/api/v1/orders'))).toBe(true)
    expect(graph.hasNode(routeId('php-slim-baseline', 'GET', '/echo'))).toBe(true)
    // The Cache.php `->get('quote:key')` never minted a route.
    expect(graph.hasNode(routeId('php-slim-baseline', 'GET', '/quote:key'))).toBe(false)

    // The service owns its routes through a CONTAINS edge pinned to the route file.
    const containsId = extractedEdgeId(svc, getquote, EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe('public/index.php')
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
