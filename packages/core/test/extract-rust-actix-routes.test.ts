import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Parser from 'tree-sitter'
import Rust from 'tree-sitter-rust'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { actixRoutesFromSource, normalizePathTemplate } from '../src/extract/routes.js'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  routeId,
  serviceId,
} from '@neat.is/types'

// ADR-206 — Rust/Actix-Web route extraction, the net-new Rust route recognizer
// (Rust reached symbol grain in ADR-201 but had no route reader). Actix declares
// routes with attribute macros on the handler fn (`#[post("/ship-order")]`) and
// with the App builder (`.route("/x", web::post().to(h))`); the actix-web OTel
// instrumentation sets `http.route` to the matched pattern, so a declared template
// lands on the same RouteNode a server span fuses onto through
// `normalizePathTemplate` with no ingest change.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'rust-actix-baseline')

function rustParser(): Parser {
  const p = new Parser()
  p.setLanguage(Rust)
  return p
}

// Render each extracted route as a `METHOD /template` tuple, the grain the
// assertions read.
function tuples(source: string): string[] {
  return actixRoutesFromSource(source, rustParser()).map((r) => `${r.method} ${r.pathTemplate}`)
}

const mainRs = readFileSync(path.join(FIXTURE, 'src', 'main.rs'), 'utf8')

describe('actixRoutesFromSource (ADR-206)', () => {
  const got = tuples(mainRs)

  it('reads the attribute-macro verb routes, method taken from the macro name', () => {
    expect(got).toContain('POST /get-quote')
    expect(got).toContain('POST /ship-order')
    expect(got).toContain('GET /health')
  })

  it('fans a `#[route(..., method = ...)]` macro out to one route per method', () => {
    expect(got).toContain('GET /status')
    expect(got).toContain('HEAD /status')
  })

  it('reads the App builder `.route(path, web::verb().to(h))` form', () => {
    expect(got).toContain('POST /legacy-quote')
  })

  it('does not mint a route from a derive macro or a non-route attribute', () => {
    // `#[derive(...)]` / `#[actix_web::main]` name no path — nothing leaks in.
    expect(got.some((t) => t.includes('derive'))).toBe(false)
    expect(got.some((t) => t.includes('main'))).toBe(false)
    // Exactly the six routes above, no more.
    expect(got.length).toBe(6)
  })

  it('a bare builder `.route` with no resolvable web::verb mints nothing', () => {
    const src = `use actix_web::{web, App};
fn build() {
    App::new().route("/unknown", web::route());
    App::new().route("/mounted", other::handler());
}`
    expect(tuples(src)).toEqual([])
  })

  it('a template reduces to the same key an actix-web http.route does', () => {
    const src = `use actix_web::{get};
#[get("/orders/{id}")]
async fn show() {}`
    expect(tuples(src)).toEqual(['GET /orders/{id}'])
    expect(normalizePathTemplate('/orders/{id}')).toBe('/orders/:param')
    expect(normalizePathTemplate('/orders/{id}')).toBe(normalizePathTemplate('/orders/42'))
  })
})

// End-to-end: Cargo.toml discovers a Rust service gated on actix-web, the grammar
// loads, and the routes materialize as RouteNodes owned by the service — the shape
// an actix-web server span fuses onto.
describe('Actix route extraction end-to-end (ADR-206)', () => {
  beforeEach(() => resetGraph())

  it('discovers the actix-web service and materializes its routes as RouteNodes', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, FIXTURE)
    expect(result.extractionErrors).toBe(0)

    // The Cargo `[package] name` names the service — `shipping`, the otel-demo name.
    const svc = serviceId('shipping')
    expect(graph.hasNode(svc)).toBe(true)
    expect((graph.getNodeAttributes(svc) as { language: string }).language).toBe('rust')

    const shipOrder = routeId('shipping', 'POST', '/ship-order')
    expect(graph.hasNode(shipOrder)).toBe(true)
    const node = graph.getNodeAttributes(shipOrder) as RouteNode
    expect(node.type).toBe(NodeType.RouteNode)
    expect(node.method).toBe('POST')
    expect(node.pathTemplate).toBe('/ship-order')
    expect(node.framework).toBe('actix-web')
    expect(node.path).toBe('src/main.rs')

    // The other otel-demo endpoint and the multi-method macro land too.
    expect(graph.hasNode(routeId('shipping', 'POST', '/get-quote'))).toBe(true)
    expect(graph.hasNode(routeId('shipping', 'GET', '/status'))).toBe(true)
    expect(graph.hasNode(routeId('shipping', 'HEAD', '/status'))).toBe(true)
    expect(graph.hasNode(routeId('shipping', 'POST', '/legacy-quote'))).toBe(true)

    // The service owns its routes through a CONTAINS edge pinned to the source file.
    const containsId = extractedEdgeId(svc, shipOrder, EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe('src/main.rs')
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
