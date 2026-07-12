import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  routeId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { isTestPath, type DiscoveredService } from './shared.js'
import { recordExtractionError } from './errors.js'
import { loadSourceFiles, snippet, toPosix } from './calls/shared.js'

// Server-route extraction (ADR-119). Reads a mainstream router's route table —
// Express (`app.get`/`router.post`/…), Fastify (`fastify.get`, `fastify.route`),
// Next.js (app-router `route.*` handlers, pages `api/` handlers) — and
// materialises each route as a RouteNode at (method, path-template) grain, owned
// by its service through a `service ──CONTAINS──▶ route` edge. This is the
// server half of the static contract-matching in calls/route-match.ts: a
// client call site is matched to the route it names, bridging the two static
// islands into a route-grained cross-service CALLS edge.
//
// Scope is mainstream routers only, gated by manifest dependency (the extensible
// registry pattern — coverage grows one router at a time, not by exhaustive
// heuristics). A service with none of these deps is skipped.

const PARSE_CHUNK = 16384

function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) =>
    index >= source.length ? '' : source.slice(index, index + PARSE_CHUNK),
  )
}

function makeJsParser(): Parser {
  const p = new Parser()
  p.setLanguage(JavaScript)
  return p
}

// The HTTP verbs an Express / Fastify router registers a route under. `all`
// registers a method-agnostic route; it normalises to the `ALL` method token.
const ROUTER_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
  'all',
])

// The exported handler names a Next.js app-router `route.*` file uses, one per
// HTTP method it serves.
const NEXT_APP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

const JS_ROUTE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])

export interface ExtractedRoute {
  method: string // upper-cased HTTP method, or 'ALL' for a method-agnostic route
  pathTemplate: string // canonicalised declared template, e.g. '/users/:id'
  line: number // 1-indexed line the route is declared on
  framework: string // 'express' | 'fastify' | 'next'
}

// ── path-template canonicalisation ──────────────────────────────────────────

// Canonicalise a declared route path for use as a RouteNode's stable template:
// drop any query/hash, ensure a leading slash, drop a trailing slash (except
// root). The template keeps its declared params verbatim (`:id`, `{id}`) so an
// OBSERVED server span carrying the same `http.route` lands on the same node.
export function canonicalizeTemplate(raw: string): string {
  let p = raw.split('?')[0]!.split('#')[0]!
  if (!p.startsWith('/')) p = '/' + p
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

// A path segment is dynamic when it names a parameter rather than a literal.
// Covers the router param syntaxes (`:id`, `{id}`, `[id]`, `[...slug]`), a
// reconstructed client interpolation (`:param`), and a concrete value a client
// URL carries in a param position (all-digits, uuid, long hex / Mongo id).
function isDynamicSegment(seg: string): boolean {
  if (seg.length === 0) return false
  if (seg.includes(':')) return true // :id (express/fastify) or reconstructed :param
  if (seg.startsWith('{') || seg.startsWith('[')) return true // {id} openapi, [id] next
  if (/^\d+$/.test(seg)) return true // concrete numeric id
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true // uuid
  if (/^[0-9a-f]{24,}$/i.test(seg)) return true // mongo objectid / long hex token
  return false
}

// Normalise a path-template to a param-agnostic matching key: every dynamic
// segment collapses to `:param`, every literal segment lowercases. This is the
// comparison form both a server route's declared template and a client call's
// URL path reduce to, so `/users/:id` (server) matches `/users/123` and
// `/users/${userId}` (client). The declared template is kept intact on the
// node; only matching uses this reduction.
export function normalizePathTemplate(raw: string): string {
  const canonical = canonicalizeTemplate(raw)
  const segments = canonical.split('/').filter((s) => s.length > 0)
  const normalised = segments.map((seg) => (isDynamicSegment(seg) ? ':param' : seg.toLowerCase()))
  return '/' + normalised.join('/')
}

// ── AST helpers ─────────────────────────────────────────────────────────────

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node)
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child) walk(child, visit)
  }
}

// The interior text of a string literal, stripped of quotes. Returns null for a
// template string carrying interpolation (a route path is a static literal).
function staticStringText(node: Parser.SyntaxNode): string | null {
  if (node.type === 'string') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child?.type === 'string_fragment') return child.text
    }
    // Empty string literal ('' — no fragment child).
    return ''
  }
  if (node.type === 'template_string') {
    // Only a template with no substitution is a usable static path.
    for (let i = 0; i < node.namedChildCount; i++) {
      if (node.namedChild(i)?.type === 'template_substitution') return null
    }
    const raw = node.text
    return raw.length >= 2 ? raw.slice(1, -1) : ''
  }
  return null
}

// Read a string-valued property off an object-expression node (`{ url: '/x' }`).
function objectStringProp(objNode: Parser.SyntaxNode, key: string): string | null {
  for (let i = 0; i < objNode.namedChildCount; i++) {
    const pair = objNode.namedChild(i)
    if (!pair || pair.type !== 'pair') continue
    const k = pair.childForFieldName('key')
    if (!k) continue
    const kText = k.type === 'string' ? staticStringText(k) : k.text
    if (kText !== key) continue
    const v = pair.childForFieldName('value')
    if (v) return staticStringText(v)
  }
  return null
}

// Read the `method` property off a Fastify route-options object. Accepts a
// single string (`method: 'GET'`) or an array (`method: ['GET','POST']`).
function fastifyRouteMethods(objNode: Parser.SyntaxNode): string[] {
  for (let i = 0; i < objNode.namedChildCount; i++) {
    const pair = objNode.namedChild(i)
    if (!pair || pair.type !== 'pair') continue
    const k = pair.childForFieldName('key')
    const kText = k ? (k.type === 'string' ? staticStringText(k) : k.text) : null
    if (kText !== 'method') continue
    const v = pair.childForFieldName('value')
    if (!v) return []
    if (v.type === 'string' || v.type === 'template_string') {
      const s = staticStringText(v)
      return s ? [s.toUpperCase()] : []
    }
    if (v.type === 'array') {
      const out: string[] = []
      for (let j = 0; j < v.namedChildCount; j++) {
        const el = v.namedChild(j)
        if (el && (el.type === 'string' || el.type === 'template_string')) {
          const s = staticStringText(el)
          if (s) out.push(s.toUpperCase())
        }
      }
      return out
    }
  }
  return []
}

// ── Express / Fastify / Hono call-expression routes ─────────────────────────

// Recognise route registrations of the shape `<router>.<method>('/path', …)`
// — Express, Fastify, and Hono (`hono.get('/path', handler)` etc.) all share
// this exact call shape (ADR-133 §5: same registry pattern, Cloudflare
// Worker's route-grain fast-follow) — and Fastify's own generic
// `<fastify>.route({ method, url })` form. The guard that keeps this off
// `db.get('key')` / `_.get(obj, path)` is a string first argument that starts
// with '/', combined with the caller-side dep gate in addRoutes (only
// services that depend on express / fastify / hono reach here). Mount-prefix
// resolution (`app.use('/api', router)`), `.route().get()` chaining, and
// Hono's own `app.on([...methods], '/path', handler)` form are out of scope
// for this slice — the literal declared path is captured as-is. Coverage
// grows one router at a time, same discipline as the rest of this registry.
export function serverRoutesFromSource(
  source: string,
  parser: Parser,
  hasExpress: boolean,
  hasFastify: boolean,
  hasHono = false,
): ExtractedRoute[] {
  const tree = parseSource(parser, source)
  const out: ExtractedRoute[] = []
  const framework = hasExpress ? 'express' : hasFastify ? 'fastify' : hasHono ? 'hono' : 'unknown'
  walk(tree.rootNode, (node) => {
    if (node.type !== 'call_expression') return
    const fn = node.childForFieldName('function')
    if (!fn || fn.type !== 'member_expression') return
    const prop = fn.childForFieldName('property')
    if (!prop) return
    const method = prop.text.toLowerCase()
    const args = node.childForFieldName('arguments')
    const first = args?.namedChild(0)
    if (!first) return
    const line = node.startPosition.row + 1

    if (ROUTER_METHODS.has(method)) {
      const p = staticStringText(first)
      if (p && p.startsWith('/')) {
        out.push({
          method: method === 'all' ? 'ALL' : method.toUpperCase(),
          pathTemplate: canonicalizeTemplate(p),
          line,
          framework,
        })
      }
      return
    }

    // Fastify's generic form: fastify.route({ method, url }).
    if (method === 'route' && hasFastify && first.type === 'object') {
      const url = objectStringProp(first, 'url')
      if (!url || !url.startsWith('/')) return
      const methods = fastifyRouteMethods(first)
      const list = methods.length > 0 ? methods : ['ALL']
      for (const m of list) {
        out.push({
          method: m === 'ALL' ? 'ALL' : m.toUpperCase(),
          pathTemplate: canonicalizeTemplate(url),
          line,
          framework: 'fastify',
        })
      }
    }
  })
  return out
}

// ── Next.js file-convention routes ──────────────────────────────────────────

function segmentsOf(relFile: string): string[] {
  return toPosix(relFile).split('/').filter((s) => s.length > 0)
}

// An app-router route handler file: `<…>/app/**/route.{js,ts,jsx,tsx,…}` (also
// `src/app`). Route handlers live only in a file literally named `route`.
export function isNextAppRouteFile(relFile: string): boolean {
  const segs = segmentsOf(relFile)
  if (!segs.includes('app')) return false
  const base = segs[segs.length - 1] ?? ''
  return /^route\.(?:js|jsx|mjs|cjs|ts|tsx)$/.test(base)
}

// A pages-router API file: `<…>/pages/api/**/*.{js,ts,…}`. Skips Next's special
// `_app` / `_document` / `_middleware` files, which aren't routes.
export function isNextPagesApiFile(relFile: string): boolean {
  const segs = segmentsOf(relFile)
  const pagesIdx = segs.indexOf('pages')
  if (pagesIdx === -1 || segs[pagesIdx + 1] !== 'api') return false
  const base = segs[segs.length - 1] ?? ''
  if (/^_(app|document|middleware)\./.test(base)) return false
  return JS_ROUTE_EXTENSIONS.has(path.extname(base))
}

// Convert one Next path segment to its template form: route groups `(group)`
// drop out, `[...slug]` / `[[...slug]]` catch-alls and `[id]` dynamics become
// `:name`, everything else stays literal.
function nextSegment(seg: string): string | null {
  if (seg.startsWith('(') && seg.endsWith(')')) return null // route group — not in the URL
  const catchAll = seg.match(/^\[\[?\.\.\.(.+?)\]?\]$/)
  if (catchAll) return ':' + catchAll[1]
  const dynamic = seg.match(/^\[(.+?)\]$/)
  if (dynamic) return ':' + dynamic[1]
  return seg
}

// Derive the URL path-template from an app-router `route.*` file's directory:
// `app/users/[id]/route.ts` → `/users/:id`.
function nextAppPathTemplate(relFile: string): string {
  const segs = segmentsOf(relFile)
  const appIdx = segs.lastIndexOf('app')
  const between = segs.slice(appIdx + 1, segs.length - 1) // dirs between app/ and route.*
  const parts: string[] = []
  for (const seg of between) {
    const mapped = nextSegment(seg)
    if (mapped !== null) parts.push(mapped)
  }
  return '/' + parts.join('/')
}

// Derive the URL path-template from a pages `api/` file:
// `pages/api/users/[id].ts` → `/api/users/:id`, `pages/api/index.ts` → `/api`.
function nextPagesApiPathTemplate(relFile: string): string {
  const segs = segmentsOf(relFile)
  const pagesIdx = segs.indexOf('pages')
  const rest = segs.slice(pagesIdx + 1) // api/...
  const parts: string[] = []
  for (let i = 0; i < rest.length; i++) {
    let seg = rest[i]!
    if (i === rest.length - 1) {
      seg = seg.replace(/\.(?:js|jsx|mjs|cjs|ts|tsx)$/, '')
      if (seg === 'index') continue
    }
    const mapped = nextSegment(seg)
    if (mapped !== null) parts.push(mapped)
  }
  return '/' + parts.join('/')
}

// The exported HTTP-method handler names in an app-router `route.*` file:
// `export async function GET() {}` / `export const POST = …`. Each is one route.
function nextAppMethods(root: Parser.SyntaxNode): { method: string; line: number }[] {
  const out: { method: string; line: number }[] = []
  walk(root, (node) => {
    if (node.type !== 'export_statement') return
    const decl = node.childForFieldName('declaration')
    if (!decl) return
    const line = node.startPosition.row + 1
    if (decl.type === 'function_declaration') {
      const name = decl.childForFieldName('name')?.text
      if (name && NEXT_APP_METHODS.has(name)) out.push({ method: name, line })
      return
    }
    if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
      for (let i = 0; i < decl.namedChildCount; i++) {
        const d = decl.namedChild(i)
        if (d?.type !== 'variable_declarator') continue
        const name = d.childForFieldName('name')?.text
        if (name && NEXT_APP_METHODS.has(name)) out.push({ method: name, line })
      }
    }
  })
  return out
}

function nextRoutesFromFile(
  source: string,
  relFile: string,
  parser: Parser,
): ExtractedRoute[] {
  if (isNextAppRouteFile(relFile)) {
    const tree = parseSource(parser, source)
    const template = nextAppPathTemplate(relFile)
    return nextAppMethods(tree.rootNode).map(({ method, line }) => ({
      method,
      pathTemplate: canonicalizeTemplate(template),
      line,
      framework: 'next',
    }))
  }
  if (isNextPagesApiFile(relFile)) {
    // A pages API handler is the module's default export and serves every
    // method — recorded as a single method-agnostic route.
    return [
      {
        method: 'ALL',
        pathTemplate: canonicalizeTemplate(nextPagesApiPathTemplate(relFile)),
        line: 1,
        framework: 'next',
      },
    ]
  }
  return []
}

// ── producer ────────────────────────────────────────────────────────────────

export async function addRoutes(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const jsParser = makeJsParser()
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    const deps = {
      ...(service.pkg.dependencies ?? {}),
      ...(service.pkg.devDependencies ?? {}),
    }
    const hasExpress = deps['express'] !== undefined
    const hasFastify = deps['fastify'] !== undefined
    const hasHono = deps['hono'] !== undefined
    const hasNext = deps['next'] !== undefined
    if (!hasExpress && !hasFastify && !hasHono && !hasNext) continue

    const files = await loadSourceFiles(service.dir)
    for (const file of files) {
      // ADR-065 #1 — test-scope exclusion. A test that spins up a router isn't
      // the service's declared route surface.
      if (isTestPath(file.path)) continue
      if (!JS_ROUTE_EXTENSIONS.has(path.extname(file.path))) continue
      const relFile = toPosix(path.relative(service.dir, file.path))

      let routes: ExtractedRoute[]
      try {
        if (hasNext && (isNextAppRouteFile(relFile) || isNextPagesApiFile(relFile))) {
          routes = nextRoutesFromFile(file.content, relFile, jsParser)
        } else if (hasExpress || hasFastify || hasHono) {
          routes = serverRoutesFromSource(file.content, jsParser, hasExpress, hasFastify, hasHono)
        } else {
          routes = []
        }
      } catch (err) {
        recordExtractionError('route extraction', file.path, err)
        continue
      }
      if (routes.length === 0) continue

      for (const route of routes) {
        const rid = routeId(service.pkg.name, route.method, route.pathTemplate)
        if (!graph.hasNode(rid)) {
          const node: RouteNode = {
            id: rid,
            type: NodeType.RouteNode,
            name: `${route.method} ${route.pathTemplate}`,
            service: service.pkg.name,
            method: route.method,
            pathTemplate: route.pathTemplate,
            path: relFile,
            line: route.line,
            framework: route.framework,
            discoveredVia: 'static',
          }
          graph.addNode(rid, node)
          nodesAdded++
        }
        // `service ──CONTAINS──▶ route` — the service owns its routes the same
        // way it owns its files (file-awareness.md §2). Structural ownership,
        // evidence pinned to the defining file:line.
        const containsId = extractedEdgeId(service.node.id, rid, EdgeType.CONTAINS)
        if (!graph.hasEdge(containsId)) {
          const edge: GraphEdge = {
            id: containsId,
            source: service.node.id,
            target: rid,
            type: EdgeType.CONTAINS,
            provenance: Provenance.EXTRACTED,
            confidence: confidenceForExtracted('structural'),
            evidence: {
              file: relFile,
              line: route.line,
              snippet: snippet(file.content, route.line),
            },
          }
          graph.addEdgeWithKey(containsId, service.node.id, rid, edge)
          edgesAdded++
        }
      }
    }
  }

  return { nodesAdded, edgesAdded }
}
