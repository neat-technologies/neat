import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import Parser from 'tree-sitter'
import Go from 'tree-sitter-go'
import { MultiDirectedGraph } from 'graphology'
import { NodeType, routeId, type GraphEdge, type GraphNode, type RouteNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract/index.js'
import { netHttpRoutesFromSource } from '../src/extract/routes.js'

// #1420 / ADR-254 — hotel-reservation's frontend (Go 1.18) registers its routes
// on a ServeMux with bare exact paths, no method token. Go's ServeMux matches a
// pattern with no trailing slash exactly, so each is one route serving every
// method: read as method ALL. A trailing-slash subtree and "/" stay skipped
// (ADR-182). The source below is the registration block of
// DeathStarBench/hotelReservation/services/frontend/server.go.

const HOTEL_FRONTEND = `package frontend

import (
	"fmt"
	"net/http"
)

func (s *Server) Run() error {
	mux := tracing.NewServeMux(s.Tracer)
	mux.Handle("/", http.FileServer(http.FS(staticContent)))
	mux.Handle("/hotels", http.HandlerFunc(s.searchHandler))
	mux.Handle("/recommendations", http.HandlerFunc(s.recommendHandler))
	mux.Handle("/user", http.HandlerFunc(s.userHandler))
	mux.Handle("/review", http.HandlerFunc(s.reviewHandler))
	mux.Handle("/restaurants", http.HandlerFunc(s.restaurantHandler))
	mux.Handle("/museums", http.HandlerFunc(s.museumHandler))
	mux.Handle("/cinema", http.HandlerFunc(s.cinemaHandler))
	mux.Handle("/reservation", http.HandlerFunc(s.reservationHandler))
	return http.ListenAndServe(fmt.Sprintf(":%d", s.Port), mux)
}
`

const HOTEL_PATHS = ['/hotels', '/recommendations', '/user', '/review', '/restaurants', '/museums', '/cinema', '/reservation']

function parser(): Parser {
  const p = new Parser()
  p.setLanguage(Go as unknown as Parser.Language)
  return p
}
function tuples(src: string): Array<[string, string]> {
  return netHttpRoutesFromSource(src, parser()).map((r) => [r.method, r.pathTemplate])
}

describe('net/http exact paths with no method token (ADR-254)', () => {
  it("reads hotel frontend's registrations as ALL routes, skipping /", () => {
    expect(tuples(HOTEL_FRONTEND)).toEqual(HOTEL_PATHS.map((p) => ['ALL', p]))
  })

  it('keeps skipping a trailing-slash subtree and the root', () => {
    const src = `package main
import "net/http"
func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/orders/", listOrders)
	http.HandleFunc("/", index)
	http.HandleFunc("orders", h)
}`
    expect(tuples(src)).toEqual([])
  })

  it('reads http.HandleFunc and a param-looking exact path the same way', () => {
    const src = `package main
import "net/http"
func main() {
	http.HandleFunc("/healthz", health)
	http.HandleFunc("/users/{id}", user)
}`
    expect(tuples(src)).toEqual([
      ['ALL', '/healthz'],
      ['ALL', '/users/{id}'],
    ])
  })

  it('still needs the net/http import', () => {
    const src = `package main
func main() {
	mux.Handle("/hotels", h)
}`
    expect(tuples(src)).toEqual([])
  })

  it('a method-prefixed pattern still reads its method', () => {
    const src = `package main
import "net/http"
func main() {
	mux.HandleFunc("GET /orders/{id}", getOrder)
	mux.HandleFunc("/orders", orders)
}`
    expect(tuples(src)).toEqual([
      ['GET', '/orders/{id}'],
      ['ALL', '/orders'],
    ])
  })

  describe('end to end, as hotel ships it (go 1.18)', () => {
    let dir: string
    beforeAll(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-1420b-'))
      await fs.mkdir(path.join(dir, 'frontend'))
      await fs.writeFile(path.join(dir, 'frontend', 'go.mod'), 'module example.com/frontend\n\ngo 1.18\n')
      await fs.writeFile(path.join(dir, 'frontend', 'server.go'), HOTEL_FRONTEND)
    })
    afterAll(async () => {
      await fs.rm(dir, { recursive: true, force: true })
    })

    it('mints one RouteNode per exact path on the frontend service', async () => {
      const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
      await extractFromDirectory(g, dir)
      const routes = g
        .filterNodes((_id, a) => (a as GraphNode).type === NodeType.RouteNode)
        .map((id) => g.getNodeAttributes(id) as RouteNode)
      expect(routes.map((r) => r.pathTemplate).sort()).toEqual([...HOTEL_PATHS].sort())
      const service = routes[0]!.service
      for (const p of HOTEL_PATHS) {
        const node = g.getNodeAttributes(routeId(service, 'ALL', p)) as RouteNode
        expect(node.method).toBe('ALL')
        expect(node.framework).toBe('net/http')
      }
    })
  })
})
