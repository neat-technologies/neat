import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Parser from 'tree-sitter'
import Go from 'tree-sitter-go'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import {
  echoRoutesFromSource,
  fiberRoutesFromSource,
  normalizePathTemplate,
} from '../src/extract/routes.js'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  routeId,
  serviceId,
} from '@neat.is/types'

// ADR-181 — Echo and Fiber join Go's route recognizers next to Gin (which they
// share a route shape with). Each declares routes as `<router>.VERB("/path", h)`
// with `Group()` prefix composition, and each framework's OTel middleware sets
// `http.route` to the group-composed template (Echo's `c.Path()`, Fiber's
// `c.Route().Path`), so an extracted template fuses through `normalizePathTemplate`
// with no ingest change.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'go-echo-fiber')

function goParser(): Parser {
  const p = new Parser()
  p.setLanguage(Go)
  return p
}

// Render each extracted route as a `METHOD /template` tuple, the grain the
// assertions read.
function echoTuples(source: string): string[] {
  return echoRoutesFromSource(source, goParser()).map((r) => `${r.method} ${r.pathTemplate}`)
}
function fiberTuples(source: string): string[] {
  return fiberRoutesFromSource(source, goParser()).map((r) => `${r.method} ${r.pathTemplate}`)
}

describe('echoRoutesFromSource (ADR-181)', () => {
  it('reads the explicit verb routes off the top-level router', () => {
    const src = `package main
import "github.com/labstack/echo/v4"
func main() {
	e := echo.New()
	e.GET("/orders/:id", getOrder)
	e.POST("/orders", createOrder)
	e.PUT("/orders/:id", replaceOrder)
	e.PATCH("/orders/:id", patchOrder)
	e.DELETE("/orders/:id", deleteOrder)
}`
    expect(echoTuples(src)).toEqual([
      'GET /orders/:id',
      'POST /orders',
      'PUT /orders/:id',
      'PATCH /orders/:id',
      'DELETE /orders/:id',
    ])
  })

  it('composes a single group prefix onto the routes registered on it', () => {
    const src = `package main
import "github.com/labstack/echo/v4"
func main() {
	e := echo.New()
	g := e.Group("/admin")
	g.GET("/users/:id", getUser)
	g.POST("/users", createUser)
}`
    expect(echoTuples(src)).toEqual(['GET /admin/users/:id', 'POST /admin/users'])
  })

  it('composes nested group prefixes through the parent group', () => {
    const src = `package main
import "github.com/labstack/echo/v4"
func main() {
	e := echo.New()
	admin := e.Group("/admin")
	v1 := admin.Group("/v1")
	v1.GET("/users/:id", getUser)
	v1.DELETE("/users/:id", deleteUser)
}`
    expect(echoTuples(src)).toEqual([
      'GET /admin/v1/users/:id',
      'DELETE /admin/v1/users/:id',
    ])
  })

  it('a grouped route reduces to the :param key otelecho\'s http.route lands on', () => {
    const src = `package main
import "github.com/labstack/echo/v4"
func main() {
	e := echo.New()
	admin := e.Group("/admin")
	admin.GET("/users/:id", getUser)
}`
    const grouped = echoRoutesFromSource(src, goParser()).find(
      (r) => r.method === 'GET' && r.pathTemplate === '/admin/users/:id',
    )
    expect(grouped).toBeDefined()
    // otelecho sets http.route from c.Path() = the group-composed template, verbatim.
    const observedHttpRoute = '/admin/users/:id'
    expect(normalizePathTemplate(grouped!.pathTemplate)).toBe(
      normalizePathTemplate(observedHttpRoute),
    )
    expect(normalizePathTemplate(grouped!.pathTemplate)).toBe('/admin/users/:param')
  })
})

describe('fiberRoutesFromSource (ADR-181)', () => {
  it('reads the explicit verb routes off the top-level app', () => {
    const src = `package main
import "github.com/gofiber/fiber/v2"
func main() {
	app := fiber.New()
	app.Get("/orders/:id", getOrder)
	app.Post("/orders", createOrder)
	app.Put("/orders/:id", replaceOrder)
	app.Patch("/orders/:id", patchOrder)
	app.Delete("/orders/:id", deleteOrder)
}`
    expect(fiberTuples(src)).toEqual([
      'GET /orders/:id',
      'POST /orders',
      'PUT /orders/:id',
      'PATCH /orders/:id',
      'DELETE /orders/:id',
    ])
  })

  it('composes a single group prefix onto the routes registered on it', () => {
    const src = `package main
import "github.com/gofiber/fiber/v2"
func main() {
	app := fiber.New()
	api := app.Group("/api")
	api.Get("/orders/:id", getOrder)
	api.Post("/orders", createOrder)
}`
    expect(fiberTuples(src)).toEqual(['GET /api/orders/:id', 'POST /api/orders'])
  })

  it('composes nested group prefixes through the parent group', () => {
    const src = `package main
import "github.com/gofiber/fiber/v2"
func main() {
	app := fiber.New()
	api := app.Group("/api")
	v2 := api.Group("/v2")
	v2.Get("/files/*", listFiles)
}`
    expect(fiberTuples(src)).toEqual(['GET /api/v2/files/*'])
  })

  it('an optional-param route fuses despite the `?`: extracted `:id` and observed `:id?` reduce to one key', () => {
    const src = `package main
import "github.com/gofiber/fiber/v2"
func main() {
	app := fiber.New()
	api := app.Group("/api")
	api.Get("/orders/:id?", getOrder)
}`
    // canonicalizeTemplate drops the `?` (it reads as a query delimiter), so the
    // stored template is the readable `/api/orders/:id` — the Laravel `{id?}`
    // precedent (ADR-177).
    const opt = fiberRoutesFromSource(src, goParser()).find((r) => r.method === 'GET')
    expect(opt?.pathTemplate).toBe('/api/orders/:id')
    // otelfiber sets http.route from c.Route().Path, which keeps Fiber's `?`.
    const observedHttpRoute = '/api/orders/:id?'
    expect(normalizePathTemplate(opt!.pathTemplate)).toBe(normalizePathTemplate(observedHttpRoute))
    expect(normalizePathTemplate(opt!.pathTemplate)).toBe('/api/orders/:param')
  })

  it('leaves a bare `*` wildcard literal, matching what c.Route().Path reports', () => {
    // The wildcard stays literal on both the extracted template and the observed
    // http.route, so the two land on the same key with no special handling.
    expect(normalizePathTemplate('/api/files/*')).toBe('/api/files/*')
  })
})

describe('Echo + Fiber route extraction end-to-end (ADR-181)', () => {
  beforeEach(() => resetGraph())

  it('mints Echo RouteNodes gated on the go.mod dependency, with group composition and CONTAINS ownership', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const getOrder = routeId('echo-svc', 'GET', '/orders/:id')
    expect(graph.hasNode(getOrder)).toBe(true)
    const node = graph.getNodeAttributes(getOrder) as RouteNode
    expect(node.type).toBe(NodeType.RouteNode)
    expect(node.method).toBe('GET')
    expect(node.pathTemplate).toBe('/orders/:id')
    expect(node.service).toBe('echo-svc')
    expect(node.framework).toBe('echo')
    expect(node.line).toBeGreaterThan(0)

    // Group composition survives to the graph.
    expect(graph.hasNode(routeId('echo-svc', 'GET', '/admin/users/:id'))).toBe(true)
    expect(graph.hasNode(routeId('echo-svc', 'DELETE', '/admin/v1/users/:id'))).toBe(true)

    // The service owns its routes through a CONTAINS edge carrying file:line.
    const containsId = extractedEdgeId(serviceId('echo-svc'), getOrder, EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe('main.go')
  })

  it('mints Fiber RouteNodes gated on the go.mod dependency, with group composition', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const getOrder = routeId('fiber-svc', 'GET', '/orders/:id')
    expect(graph.hasNode(getOrder)).toBe(true)
    const node = graph.getNodeAttributes(getOrder) as RouteNode
    expect(node.framework).toBe('fiber')
    expect(node.method).toBe('GET')

    expect(graph.hasNode(routeId('fiber-svc', 'POST', '/orders'))).toBe(true)
    // Optional-param route stored `:id` (the `?` dropped), still owned by the service.
    expect(graph.hasNode(routeId('fiber-svc', 'GET', '/api/orders/:id'))).toBe(true)
    // Nested group + wildcard.
    expect(graph.hasNode(routeId('fiber-svc', 'GET', '/api/v2/files/*'))).toBe(true)
  })
})
