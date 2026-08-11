import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Parser from 'tree-sitter'
import Go from 'tree-sitter-go'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import {
  chiRoutesFromSource,
  netHttpRoutesFromSource,
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

// ADR-182 — Chi and net/http complete Go's route coverage next to Gin/Echo/Fiber.
// Chi reads verbs the Fiber way but composes prefixes through a closure-scoped
// stack (`Route` pushes, `Group` adds none, `Mount` is deferred); its fusion is
// conditional on otelchi's `RoutePattern()`. net/http reads a Go 1.22 ServeMux
// pattern that carries method + template in one literal, gated structurally on
// the `net/http` import plus the method-prefix shape, and auto-fuses on a modern
// stack (Go 1.23 `Request.Pattern` + otelhttp ≥ v1.36).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'go-chi-nethttp')

function goParser(): Parser {
  const p = new Parser()
  p.setLanguage(Go)
  return p
}

// Render each extracted route as a `METHOD /template` tuple, the grain the
// assertions read.
function chiTuples(source: string): string[] {
  return chiRoutesFromSource(source, goParser()).map((r) => `${r.method} ${r.pathTemplate}`)
}
function netHttpTuples(source: string): string[] {
  return netHttpRoutesFromSource(source, goParser()).map((r) => `${r.method} ${r.pathTemplate}`)
}

describe('chiRoutesFromSource (ADR-182)', () => {
  it('reads the explicit verb routes off the top-level router', () => {
    const src = `package main
import "github.com/go-chi/chi/v5"
func main() {
	r := chi.NewRouter()
	r.Get("/orders/{id}", getOrder)
	r.Post("/orders", createOrder)
	r.Put("/orders/{id}", replaceOrder)
	r.Patch("/orders/{id}", patchOrder)
	r.Delete("/orders/{id}", deleteOrder)
}`
    expect(chiTuples(src)).toEqual([
      'GET /orders/{id}',
      'POST /orders',
      'PUT /orders/{id}',
      'PATCH /orders/{id}',
      'DELETE /orders/{id}',
    ])
  })

  it('composes a Route closure prefix onto the routes registered inside it', () => {
    const src = `package main
import "github.com/go-chi/chi/v5"
func main() {
	r := chi.NewRouter()
	r.Route("/articles", func(r chi.Router) {
		r.Get("/{articleID}", getArticle)
		r.Post("/", createArticle)
	})
}`
    expect(chiTuples(src)).toEqual(['GET /articles/{articleID}', 'POST /articles'])
  })

  it('composes nested Route prefixes through the parent closure', () => {
    const src = `package main
import "github.com/go-chi/chi/v5"
func main() {
	r := chi.NewRouter()
	r.Route("/articles", func(r chi.Router) {
		r.Route("/{articleID}", func(r chi.Router) {
			r.Get("/comments", listComments)
		})
	})
}`
    expect(chiTuples(src)).toEqual(['GET /articles/{articleID}/comments'])
  })

  it('a Group closure contributes no prefix — only its enclosing Route does', () => {
    const src = `package main
import "github.com/go-chi/chi/v5"
func main() {
	r := chi.NewRouter()
	r.Route("/articles", func(r chi.Router) {
		r.Group(func(r chi.Router) {
			r.Delete("/{articleID}", deleteArticle)
		})
	})
}`
    // Group adds nothing; the route still carries only the Route prefix.
    expect(chiTuples(src)).toEqual(['DELETE /articles/{articleID}'])
  })

  it('strips an inline regex constraint and still collapses to :param at match time', () => {
    const src = `package main
import "github.com/go-chi/chi/v5"
func main() {
	r := chi.NewRouter()
	r.Get("/users/{id:[0-9]+}", getUser)
}`
    const route = chiRoutesFromSource(src, goParser()).find((r) => r.method === 'GET')
    expect(route?.pathTemplate).toBe('/users/{id}')
    expect(normalizePathTemplate(route!.pathTemplate)).toBe('/users/:param')
  })

  it('a Route-composed template reduces to the :param key otelchi\'s RoutePattern lands on', () => {
    const src = `package main
import "github.com/go-chi/chi/v5"
func main() {
	r := chi.NewRouter()
	r.Route("/articles", func(r chi.Router) {
		r.Get("/{articleID}", getArticle)
	})
}`
    const grouped = chiRoutesFromSource(src, goParser()).find(
      (r) => r.method === 'GET' && r.pathTemplate === '/articles/{articleID}',
    )
    expect(grouped).toBeDefined()
    // otelchi sets http.route from chi.RouteContext(r).RoutePattern() = the
    // composed template, verbatim.
    const observedHttpRoute = '/articles/{articleID}'
    expect(normalizePathTemplate(grouped!.pathTemplate)).toBe(
      normalizePathTemplate(observedHttpRoute),
    )
    expect(normalizePathTemplate(grouped!.pathTemplate)).toBe('/articles/:param')
  })

  it('defers Mount — the mounted prefix composes no route', () => {
    const src = `package main
import (
	"net/http"
	"github.com/go-chi/chi/v5"
)
func main() {
	r := chi.NewRouter()
	r.Get("/health", health)
	r.Mount("/admin", http.FileServer(http.Dir("./static")))
}`
    expect(chiTuples(src)).toEqual(['GET /health'])
  })
})

describe('netHttpRoutesFromSource (ADR-182)', () => {
  it('reads a method-prefixed ServeMux pattern as one route', () => {
    const src = `package main
import "net/http"
func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /orders/{id}", getOrder)
	mux.HandleFunc("POST /orders", createOrder)
}`
    expect(netHttpTuples(src)).toEqual(['GET /orders/{id}', 'POST /orders'])
  })

  it('reads http.HandleFunc, mux.Handle, and the {path...} / {$} template forms', () => {
    const src = `package main
import "net/http"
func main() {
	mux := http.NewServeMux()
	mux.Handle("GET /assets/{path...}", fs)
	http.HandleFunc("DELETE /orders/{id}", deleteOrder)
	mux.HandleFunc("GET /{$}", home)
}`
    expect(netHttpTuples(src)).toEqual([
      'GET /assets/{path...}',
      'DELETE /orders/{id}',
      'GET /{$}',
    ])
    // Each template collapses to a single :param under normalizePathTemplate,
    // exactly the shape a Go 1.23 Request.Pattern (method stripped) reduces to.
    expect(normalizePathTemplate('/assets/{path...}')).toBe('/assets/:param')
    expect(normalizePathTemplate('/{$}')).toBe('/:param')
  })

  it('does not emit a bare-prefix pattern with no method token', () => {
    const src = `package main
import "net/http"
func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/orders/", listOrders)
}`
    expect(netHttpTuples(src)).toEqual([])
  })

  it('skips a HandleFunc whose literal is not a method-prefixed path', () => {
    const src = `package main
import "net/http"
func main() {
	x.HandleFunc("literal", h)
}`
    expect(netHttpTuples(src)).toEqual([])
  })

  it('does not fire without a net/http import, even on the pattern shape', () => {
    // The structural gate: no `import "net/http"` means no route, so a same-named
    // HandleFunc on some other value can never misfire.
    const src = `package main
func main() {
	mux.HandleFunc("GET /orders/{id}", getOrder)
}`
    expect(netHttpTuples(src)).toEqual([])
  })

  it('skips a host-prefixed pattern whose remainder does not start with /', () => {
    const src = `package main
import "net/http"
func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET example.com/orders", getOrder)
}`
    expect(netHttpTuples(src)).toEqual([])
  })
})

describe('Chi + net/http route extraction end-to-end (ADR-182)', () => {
  beforeEach(() => resetGraph())

  it('mints Chi RouteNodes gated on the go.mod dependency, composing Route prefixes and deferring Mount', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const getOrder = routeId('chi-svc', 'GET', '/orders/{id}')
    expect(graph.hasNode(getOrder)).toBe(true)
    const node = graph.getNodeAttributes(getOrder) as RouteNode
    expect(node.type).toBe(NodeType.RouteNode)
    expect(node.method).toBe('GET')
    expect(node.pathTemplate).toBe('/orders/{id}')
    expect(node.service).toBe('chi-svc')
    expect(node.framework).toBe('chi')
    expect(node.line).toBeGreaterThan(0)

    expect(graph.hasNode(routeId('chi-svc', 'POST', '/orders'))).toBe(true)
    // Inline regex stripped to the clean template.
    expect(graph.hasNode(routeId('chi-svc', 'GET', '/users/{id}'))).toBe(true)
    // Wildcard stays literal.
    expect(graph.hasNode(routeId('chi-svc', 'GET', '/files/*'))).toBe(true)
    // Route closure composition survives to the graph.
    expect(graph.hasNode(routeId('chi-svc', 'GET', '/articles/{articleID}'))).toBe(true)
    // Group adds no prefix; the Route prefix still lands.
    expect(graph.hasNode(routeId('chi-svc', 'DELETE', '/articles/{articleID}'))).toBe(true)
    // Mount is deferred — no /admin route is composed.
    expect(graph.hasNode(routeId('chi-svc', 'GET', '/admin'))).toBe(false)

    // The service owns its routes through a CONTAINS edge carrying file:line.
    const containsId = extractedEdgeId(serviceId('chi-svc'), getOrder, EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe('main.go')
  })

  it('mints net/http RouteNodes with no go.mod dep, gated structurally per file', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const getOrder = routeId('nethttp-svc', 'GET', '/orders/{id}')
    expect(graph.hasNode(getOrder)).toBe(true)
    const node = graph.getNodeAttributes(getOrder) as RouteNode
    expect(node.framework).toBe('net/http')
    expect(node.method).toBe('GET')

    expect(graph.hasNode(routeId('nethttp-svc', 'POST', '/orders'))).toBe(true)
    expect(graph.hasNode(routeId('nethttp-svc', 'GET', '/assets/{path...}'))).toBe(true)
    expect(graph.hasNode(routeId('nethttp-svc', 'GET', '/{$}'))).toBe(true)
    // The bare-prefix /legacy/ registration carries no method and mints nothing.
    expect(graph.hasNode(routeId('nethttp-svc', 'GET', '/legacy'))).toBe(false)
    expect(graph.hasNode(routeId('nethttp-svc', 'ALL', '/legacy'))).toBe(false)
  })
})
