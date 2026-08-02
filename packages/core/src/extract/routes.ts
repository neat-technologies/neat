import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import Python from 'tree-sitter-python'
import Go from 'tree-sitter-go'
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
import { loadSourceFiles, snippet, toPosix, type SourceFile } from './calls/shared.js'
import { resolveJsImport, loadTsPathConfig, type TsPathConfig } from './imports.js'

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

function makePyParser(): Parser {
  const p = new Parser()
  p.setLanguage(Python)
  return p
}

function makeGoParser(): Parser {
  const p = new Parser()
  p.setLanguage(Go)
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
  framework: string // Router registry label; NestJS joins the existing JS/Python set in ADR-155.
}

export function ginRoutesFromSource(source: string, parser: Parser): ExtractedRoute[] {
  const tree = parseSource(parser, source)
  const prefixes = new Map<string, string>()
  const out: ExtractedRoute[] = []
  walk(tree.rootNode, (node) => {
    if (node.type === 'short_var_declaration' || node.type === 'var_spec') {
      const name = node.childForFieldName('left')?.namedChild(0)?.text ?? node.childForFieldName('name')?.text
      const value = node.childForFieldName('right')?.namedChild(0) ?? node.childForFieldName('value')
      if (name && value?.type === 'call_expression') {
        const fn = value.childForFieldName('function')
        const field = fn?.childForFieldName('field')?.text
        const first = value.childForFieldName('arguments')?.namedChild(0)
        if (field === 'Group' && first?.type === 'interpreted_string_literal') {
          prefixes.set(name, first.text.slice(1, -1))
        }
      }
      return
    }
    if (node.type !== 'call_expression') return
    const fn = node.childForFieldName('function')
    if (fn?.type !== 'selector_expression') return
    const method = fn.childForFieldName('field')?.text?.toUpperCase()
    if (!method || !ROUTER_METHODS.has(method.toLowerCase())) return
    const receiver = fn.childForFieldName('operand')?.text ?? ''
    const first = node.childForFieldName('arguments')?.namedChild(0)
    if (first?.type !== 'interpreted_string_literal') return
    const leaf = first.text.slice(1, -1)
    out.push({
      method: method === 'ALL' ? 'ALL' : method,
      pathTemplate: canonicalizeTemplate((prefixes.get(receiver) ?? '') + leaf),
      line: node.startPosition.row + 1,
      framework: 'gin',
    })
  })
  return out
}

// The HTTP verbs FastAPI/Starlette register a route decorator under
// (`@router.get(...)`, `@app.post(...)`, …). `api_route` is handled separately —
// it carries its methods in a `methods=[…]` keyword argument.
const FASTAPI_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'])

const NESTJS_METHODS = new Map([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Patch', 'PATCH'],
  ['Delete', 'DELETE'],
  ['Options', 'OPTIONS'],
  ['Head', 'HEAD'],
  ['All', 'ALL'],
])

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

// ── NestJS decorator routes ────────────────────────────────────────────────

// Collect only route decorators imported by name from `@nestjs/common`.
// The local name is the key, so `Get as Read` remains deterministic without
// admitting an unrelated decorator that happens to be named `Get`.
function nestDecoratorImports(root: Parser.SyntaxNode): Map<string, string> {
  const imports = new Map<string, string>()
  walk(root, (node) => {
    if (node.type !== 'import_statement') return
    const source = node.childForFieldName('source')
    if (!source || staticStringText(source) !== '@nestjs/common') return
    walk(node, (child) => {
      if (child.type !== 'import_specifier') return
      const imported = child.childForFieldName('name')?.text
      const local = child.childForFieldName('alias')?.text ?? imported
      if (!imported || !local) return
      if (imported === 'Controller' || NESTJS_METHODS.has(imported)) {
        imports.set(local, imported)
      }
    })
  })
  return imports
}

function decoratorCall(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type !== 'decorator') return null
  const expression = node.namedChild(0)
  return expression?.type === 'call_expression' ? expression : null
}

function decoratorCanonicalName(
  decorator: Parser.SyntaxNode,
  imports: Map<string, string>,
): string | null {
  const call = decoratorCall(decorator)
  const fn = call?.childForFieldName('function')
  if (!fn || fn.type !== 'identifier') return null
  return imports.get(fn.text) ?? null
}

// Nest accepts one path or an array of paths on both Controller and method
// decorators. Keep only static alternatives; a computed member contributes no
// guessed route. No argument is the empty path segment.
function nestStaticPaths(call: Parser.SyntaxNode): string[] {
  const args = call.childForFieldName('arguments')
  const first = args?.namedChild(0)
  if (!first) return ['']
  const single = staticStringText(first)
  if (single !== null) return [single]
  if (first.type !== 'array') return []
  const paths: string[] = []
  for (let i = 0; i < first.namedChildCount; i++) {
    const item = first.namedChild(i)
    if (!item) continue
    const value = staticStringText(item)
    if (value !== null) paths.push(value)
  }
  return paths
}

function nestJoinedPath(prefix: string, leaf: string): string {
  const segments = [prefix, leaf]
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0)
  return canonicalizeTemplate(segments.join('/'))
}

// Nest composes class-level `@Controller()` metadata with method-level HTTP
// decorators. The method decorator is the definition site, so its line is the
// evidence line and matches where a maintainer edits the route.
export function nestjsRoutesFromSource(source: string, parser: Parser): ExtractedRoute[] {
  const tree = parseSource(parser, source)
  const imports = nestDecoratorImports(tree.rootNode)
  if (![...imports.values()].includes('Controller')) return []

  const out: ExtractedRoute[] = []
  walk(tree.rootNode, (node) => {
    if (node.type !== 'class_declaration') return
    const decoratorOwner = node.parent?.type === 'export_statement' ? node.parent : node
    const classDecorators: Parser.SyntaxNode[] = []
    for (let i = 0; i < decoratorOwner.namedChildCount; i++) {
      const child = decoratorOwner.namedChild(i)
      if (child?.type === 'decorator') classDecorators.push(child)
    }
    const controller = classDecorators.find(
      (decorator) => decoratorCanonicalName(decorator, imports) === 'Controller',
    )
    const controllerCall = controller ? decoratorCall(controller) : null
    if (!controllerCall) return
    const prefixes = nestStaticPaths(controllerCall)
    if (prefixes.length === 0) return

    const body = node.childForFieldName('body')
    if (!body) return
    for (let i = 0; i < body.namedChildCount; i++) {
      const methodNode = body.namedChild(i)
      if (methodNode?.type !== 'method_definition') continue
      for (let j = 0; j < methodNode.namedChildCount; j++) {
        const decorator = methodNode.namedChild(j)
        if (decorator?.type !== 'decorator') continue
        const canonical = decoratorCanonicalName(decorator, imports)
        const method = canonical ? NESTJS_METHODS.get(canonical) : undefined
        const call = decoratorCall(decorator)
        if (!method || !call) continue
        const leaves = nestStaticPaths(call)
        for (const prefix of prefixes) {
          for (const leaf of leaves) {
            out.push({
              method,
              pathTemplate: nestJoinedPath(prefix, leaf),
              line: decorator.startPosition.row + 1,
              framework: 'nestjs',
            })
          }
        }
      }
    }
  })
  return out
}

// ── Express / Fastify / Hono call-expression routes ─────────────────────────

// Recognise route registrations of the shape `<router>.<method>('/path', …)`
// — Express, Fastify, and Hono (`hono.get('/path', handler)` etc.) all share
// this exact call shape (ADR-133 §5: same registry pattern, Cloudflare
// Worker's route-grain fast-follow) — and Fastify's own generic
// `<fastify>.route({ method, url })` form. The guard that keeps this off
// `db.get('key')` / `_.get(obj, path)` is a string first argument that starts
// with '/', combined with the caller-side dep gate in addRoutes (only
// services that depend on express / fastify / hono reach here). This per-file
// scan captures the leaf path as declared; the Express mount prefix
// (`app.use('/api', router)`) is composed onto it afterwards by
// `expressMountPrefixes` (ADR-160), the whole-program pass that resolves the
// mounted router across files. `.route().get()` chaining and Hono's own
// `app.on([...methods], '/path', handler)` form remain out of scope for this
// slice. Coverage grows one router at a time, same discipline as the registry.
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

// ── Python / FastAPI decorator routes ───────────────────────────────────────

// The interior text of a Python string literal, stripped of quotes. Returns
// null for an f-string carrying interpolation (a route path is a static
// literal); returns '' for an empty string (no `string_content` child).
function pyStaticStringText(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'string') return null
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child?.type === 'interpolation') return null // f-string — not a static path
    if (child?.type === 'string_content') return child.text
  }
  return ''
}

// Read a keyword argument whose value is a list of string literals:
// `methods=['GET','POST']` → ['GET','POST']. Anything else → [].
function keywordArrayStrings(argsNode: Parser.SyntaxNode, key: string): string[] {
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const arg = argsNode.namedChild(i)
    if (arg?.type !== 'keyword_argument') continue
    if (arg.childForFieldName('name')?.text !== key) continue
    const val = arg.childForFieldName('value')
    if (!val || val.type !== 'list') return []
    const out: string[] = []
    for (let j = 0; j < val.namedChildCount; j++) {
      const el = val.namedChild(j)
      if (el?.type === 'string') {
        const s = pyStaticStringText(el)
        if (s) out.push(s)
      }
    }
    return out
  }
  return []
}

// Map an in-file router/blueprint variable to its declared literal prefix:
// FastAPI `router = APIRouter(prefix='/items')` → { router: '/items' }, Flask
// `bp = Blueprint('x', __name__, url_prefix='/api')` → { bp: '/api' }. Handles
// bare and dotted constructors (`fastapi.APIRouter(...)`), the prefix kwarg in
// any position. A prefix built from a config symbol or an f-string
// (`prefix=settings.API_V1_STR`) stays unmapped — the router contributes no
// prefix rather than a guessed one, and the leaf-relative path is kept honestly.
function collectPythonRouterPrefixes(root: Parser.SyntaxNode): Map<string, string> {
  const prefixes = new Map<string, string>()
  walk(root, (node) => {
    if (node.type !== 'assignment') return
    const right = node.childForFieldName('right')
    if (!right || right.type !== 'call') return
    const fn = right.childForFieldName('function')
    if (!fn) return
    const ctor = fn.type === 'attribute' ? fn.childForFieldName('attribute')?.text : fn.text
    // FastAPI's APIRouter names its mount `prefix`; Flask's Blueprint names it
    // `url_prefix`. Any other constructor contributes no prefix.
    const prefixKey = ctor === 'APIRouter' ? 'prefix' : ctor === 'Blueprint' ? 'url_prefix' : null
    if (!prefixKey) return
    const left = node.childForFieldName('left')
    if (!left || left.type !== 'identifier') return
    const args = right.childForFieldName('arguments')
    if (!args) return
    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i)
      if (arg?.type !== 'keyword_argument') continue
      if (arg.childForFieldName('name')?.text !== prefixKey) continue
      const val = arg.childForFieldName('value')
      const p = val ? pyStaticStringText(val) : null
      if (p !== null) prefixes.set(left.text, p)
    }
  })
  return prefixes
}

// Module-level string constants, for resolving a mount prefix given as a symbol
// (`prefix=API_V1_STR` or `prefix=settings.API_V1_STR`) rather than a literal.
function collectStringConstants(root: Parser.SyntaxNode): Map<string, string> {
  const consts = new Map<string, string>()
  walk(root, (node) => {
    if (node.type !== 'assignment') return
    const left = node.childForFieldName('left')
    const right = node.childForFieldName('right')
    if (left?.type !== 'identifier' || right?.type !== 'string') return
    const v = pyStaticStringText(right)
    if (v !== null) consts.set(left.text, v)
  })
  return consts
}

// Resolve a mount-prefix argument: a literal string, a bare constant
// (`API_V1_STR`), or an attribute (`settings.API_V1_STR`) whose trailing name is
// a known in-file constant. Anything else → null (unmapped, kept honest).
function resolvePrefixArg(node: Parser.SyntaxNode | null, consts: Map<string, string>): string | null {
  if (!node) return null
  if (node.type === 'string') return pyStaticStringText(node)
  if (node.type === 'identifier') return consts.get(node.text) ?? null
  if (node.type === 'attribute') {
    const attr = node.childForFieldName('attribute')?.text
    return attr ? (consts.get(attr) ?? null) : null
  }
  return null
}

// In-file mounts — `app.include_router(<router>, prefix=<p>)` (FastAPI) and
// `app.register_blueprint(<bp>, url_prefix=<p>)` (Flask). Maps the mounted
// router/blueprint variable to its resolved mount prefix, so a route on that
// router carries the mounted path. A cross-file mount (the router imported from
// another module) and nested `include_router` chains are a follow-on — the
// one-level prefix is composed, honestly.
function collectMountPrefixes(
  root: Parser.SyntaxNode,
  consts: Map<string, string>,
): Map<string, string> {
  const mounts = new Map<string, string>()
  walk(root, (node) => {
    if (node.type !== 'call') return
    const fn = node.childForFieldName('function')
    if (fn?.type !== 'attribute') return
    const method = fn.childForFieldName('attribute')?.text
    const prefixKey =
      method === 'include_router' ? 'prefix' : method === 'register_blueprint' ? 'url_prefix' : null
    if (!prefixKey) return
    const args = node.childForFieldName('arguments')
    const first = args?.namedChild(0)
    if (first?.type !== 'identifier') return // only a bare in-file router var
    let prefix: string | null = null
    for (let i = 0; i < (args?.namedChildCount ?? 0); i++) {
      const a = args!.namedChild(i)
      if (a?.type !== 'keyword_argument') continue
      if (a.childForFieldName('name')?.text !== prefixKey) continue
      prefix = resolvePrefixArg(a.childForFieldName('value'), consts)
    }
    if (prefix !== null && prefix.length > 0) mounts.set(first.text, prefix)
  })
  return mounts
}

// The decorator forms `<router>.<verb>('/path')` (FastAPI + Flask 2.0 shortcuts),
// FastAPI's `<router>.api_route('/path', methods=[…])`, and Flask's
// `<router>.route('/path', methods=[…])` (default GET). `<router>` is the app, an
// APIRouter, or a Blueprint; the path is the first positional string, read off
// the call's argument list (so a multi-line decorator still lands). A route's
// full path composes the in-file mount prefix (`app.include_router(r,
// prefix='/api/v1')`, resolving a config constant) + the router's own
// `APIRouter(prefix='/x')` / `Blueprint(url_prefix='/x')` + the decorator path.
// The declared template keeps its `{id}` params verbatim so an OBSERVED server
// span's `http.route` lands on the same node.
//
// Out of scope, deferred like express `app.use('/api', router)`: cross-file /
// nested mounting. The one-level, in-file prefix is composed as-is.
export function pythonRoutesFromSource(
  source: string,
  parser: Parser,
  framework: string,
): ExtractedRoute[] {
  const tree = parseSource(parser, source)
  const prefixes = collectPythonRouterPrefixes(tree.rootNode)
  const consts = collectStringConstants(tree.rootNode)
  const mounts = collectMountPrefixes(tree.rootNode, consts)
  const out: ExtractedRoute[] = []
  walk(tree.rootNode, (node) => {
    if (node.type !== 'decorator') return
    const call = node.namedChild(0)
    if (!call || call.type !== 'call') return
    const fn = call.childForFieldName('function')
    if (!fn || fn.type !== 'attribute') return
    const method = fn.childForFieldName('attribute')?.text?.toLowerCase()
    if (!method) return
    const isVerb = FASTAPI_METHODS.has(method)
    const isFlaskRoute = method === 'route' // Flask `.route(...)`, defaults to GET
    const isApiRoute = method === 'api_route' // FastAPI multi-method
    if (!isVerb && !isFlaskRoute && !isApiRoute) return

    const args = call.childForFieldName('arguments')
    const first = args?.namedChild(0)
    if (!first || first.type !== 'string') return
    const rawPath = pyStaticStringText(first)
    if (rawPath === null || !rawPath.startsWith('/')) return

    const obj = fn.childForFieldName('object')?.text
    const routerPrefix = obj ? (prefixes.get(obj) ?? '') : ''
    const mountPrefix = obj ? (mounts.get(obj) ?? '') : ''
    const pathTemplate = canonicalizeTemplate(mountPrefix + routerPrefix + rawPath)
    const line = node.startPosition.row + 1

    if (isVerb) {
      out.push({ method: method.toUpperCase(), pathTemplate, line, framework })
      return
    }
    // `.route` (Flask, default GET) / `.api_route` (FastAPI) — one route per method.
    const methods = keywordArrayStrings(args!, 'methods')
    const list = methods.length > 0 ? methods : isFlaskRoute ? ['GET'] : ['ALL']
    for (const m of list) {
      out.push({ method: m === 'ALL' ? 'ALL' : m.toUpperCase(), pathTemplate, line, framework })
    }
  })
  return out
}

// Back-compat alias — FastAPI is the framework-labelled specialisation.
export function fastapiRoutesFromSource(source: string, parser: Parser): ExtractedRoute[] {
  return pythonRoutesFromSource(source, parser, 'fastapi')
}

// Django URLconf routes — `urlpatterns = [path('orders/<int:pk>/', view), …]`.
// Django dispatches HTTP methods inside the view, not at the URLconf, so a route
// is method-agnostic (`ALL`). Only the modern `path()` converter form is
// recognised; an `include(...)` mount (cross-file, the Python analog of express
// `app.use`) and legacy `re_path` regex patterns are a follow-on. The `<int:pk>`
// converter param is kept verbatim and collapses to `:param` at match time.
export function djangoRoutesFromSource(source: string, parser: Parser): ExtractedRoute[] {
  const tree = parseSource(parser, source)
  const out: ExtractedRoute[] = []
  walk(tree.rootNode, (node) => {
    if (node.type !== 'assignment') return
    if (node.childForFieldName('left')?.text !== 'urlpatterns') return
    const list = node.childForFieldName('right')
    if (!list || list.type !== 'list') return
    for (let i = 0; i < list.namedChildCount; i++) {
      const el = list.namedChild(i)
      if (el?.type !== 'call') continue
      if (el.childForFieldName('function')?.text !== 'path') continue // path() only
      const args = el.childForFieldName('arguments')
      const first = args?.namedChild(0)
      if (first?.type !== 'string') continue
      const raw = pyStaticStringText(first)
      if (raw === null) continue
      // Skip an `include(...)` mount — cross-file, deferred.
      const second = args?.namedChild(1)
      if (second?.type === 'call' && second.childForFieldName('function')?.text === 'include') continue
      out.push({
        method: 'ALL',
        pathTemplate: canonicalizeTemplate(raw),
        line: el.startPosition.row + 1,
        framework: 'django',
      })
    }
  })
  return out
}

// ── Express cross-file mount-prefix composition (ADR-160) ───────────────────

// Real Express apps mount a router under a prefix — `app.use('/api', router)` —
// with the router and its routes defined in other files. The per-file scan above
// captures each leaf path (`/tags`) without the prefix, so a production span for
// `/api/tags` never fuses onto the static route. This whole-program pass composes
// the prefix onto the routes it mounts, resolving the mounted router across files
// through the same import graph `imports.ts` walks (the ADR-149 mechanism the
// Mongoose cross-file pass established).
//
// The discipline is the ADR-149 discipline: a prefix that isn't a `/`-leading
// string literal (a config symbol or computed expression), or a mounted router
// that resolves to no file, leaves the leaf path un-prefixed rather than guessing.
// A route at the wrong grain is an honest partial; a fabricated one is not.

// One `<router>.use(<prefix>, <mounted>)` mount. `prefix` is '' when the router is
// mounted at root (`app.use(router)`); `target` is the mounted binding's local
// name, or null when the argument isn't a bare identifier (middleware, a computed
// prefix followed by a router, a factory call — none of which we compose).
interface Mount {
  prefix: string
  target: string | null
}

interface RouterVarInfo {
  declares: boolean // has a direct `<var>.get('/…')` route call
  mounts: Mount[] // the routers this var mounts, via `.use()`
  aliasOf?: string // `const r2 = r1` — r2 is r1 under another name
}

interface RawBinding {
  local: string
  specifier: string
  sel: string // 'default' | 'namespace' | an export name
}

interface FileRouterInfo {
  dir: string // absolute directory of the file, for import resolution
  routerVars: Map<string, RouterVarInfo>
  appVars: Set<string> // vars bound to `express()` — the recursion roots
  exportDefaultName: string | null // routerVars key the default export resolves to
  exportNamed: Map<string, string> // export name → routerVars key
  rawBindings: RawBinding[] // imports, before cross-file resolution
  importedRouters: Map<string, { file: string; sel: string }> // local → target file + export
}

// The named arguments of a call, comments skipped.
function namedArgs(argsNode: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  if (!argsNode) return out
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const c = argsNode.namedChild(i)
    if (c && c.type !== 'comment') out.push(c)
  }
  return out
}

// Parse a `.use(...)` call into a Mount, or null when it mounts no resolvable
// router. `.use('/api', router)` → prefix '/api'; `.use(router)` → prefix '';
// `.use(cors())` / `.use(PREFIX, router)` / `.use(mw, router)` → null. A computed
// (non-literal) prefix is deliberately dropped — we compose only a literal one.
function parseUseMount(callNode: Parser.SyntaxNode): Mount | null {
  const args = namedArgs(callNode.childForFieldName('arguments'))
  if (args.length === 0) return null
  const first = args[0]!
  const firstStr =
    first.type === 'string' || first.type === 'template_string' ? staticStringText(first) : null
  if (firstStr !== null && firstStr.startsWith('/')) {
    const prefix = canonicalizeTemplate(firstStr)
    const second = args[1]
    const target = second && second.type === 'identifier' ? second.text : null
    return { prefix: prefix === '/' ? '' : prefix, target }
  }
  // A single bare identifier is a router mounted at root (`app.use(router)`).
  // Two args led by an identifier is a computed prefix or a middleware — not
  // something we can compose, so we leave it alone.
  if (args.length === 1 && first.type === 'identifier') return { prefix: '', target: first.text }
  return null
}

// Unwrap a router expression to its base and the `.use()` mounts chained onto it.
// `Router().use(a).use('/x', b)` → base 'newRouter', mounts [a, /x→b]; `express()`
// → base 'app'; a bare `router` identifier → base { alias: 'router' }. Returns
// null when the expression isn't a router value.
function unwrapRouterExpr(
  node: Parser.SyntaxNode,
  expressLocals: Set<string>,
  routerCtors: Set<string>,
): { base: 'app' | 'newRouter' | { alias: string }; mounts: Mount[] } | null {
  if (node.type === 'identifier') return { base: { alias: node.text }, mounts: [] }
  if (node.type !== 'call_expression') return null
  const fn = node.childForFieldName('function')
  if (!fn) return null

  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property')?.text
    const obj = fn.childForFieldName('object')
    if (!prop || !obj) return null
    if (prop === 'use') {
      const inner = unwrapRouterExpr(obj, expressLocals, routerCtors)
      if (!inner) return null
      const mount = parseUseMount(node)
      return { base: inner.base, mounts: mount ? [...inner.mounts, mount] : inner.mounts }
    }
    // `express.Router()`
    if (prop === 'Router' && obj.type === 'identifier' && expressLocals.has(obj.text)) {
      return { base: 'newRouter', mounts: [] }
    }
    return null
  }

  if (fn.type === 'identifier') {
    if (expressLocals.has(fn.text)) return { base: 'app', mounts: [] } // express()
    if (routerCtors.has(fn.text)) return { base: 'newRouter', mounts: [] } // Router()
  }
  return null
}

// Import bindings + which locals name express() / the Router ctor. Both ESM
// (`import express, { Router } from 'express'`) and CJS (`const { Router } =
// require('express')`) forms.
function collectExpressImports(root: Parser.SyntaxNode): {
  expressLocals: Set<string>
  routerCtors: Set<string>
  bindings: RawBinding[]
} {
  const expressLocals = new Set<string>()
  const routerCtors = new Set<string>()
  const bindings: RawBinding[] = []

  const addFromExpress = (local: string, sel: string, exported: string): void => {
    if (sel === 'default' || sel === 'namespace') expressLocals.add(local)
    else if (exported === 'Router') routerCtors.add(local)
  }

  walk(root, (node) => {
    if (node.type === 'import_statement') {
      const source = node.childForFieldName('source')
      const spec = source ? staticStringText(source) : null
      if (!spec) return
      let clause: Parser.SyntaxNode | null = null
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i)
        if (c?.type === 'import_clause') clause = c
      }
      if (!clause) return
      for (let i = 0; i < clause.namedChildCount; i++) {
        const c = clause.namedChild(i)
        if (!c) continue
        if (c.type === 'identifier') {
          if (spec === 'express') addFromExpress(c.text, 'default', 'default')
          else bindings.push({ local: c.text, specifier: spec, sel: 'default' })
        } else if (c.type === 'namespace_import') {
          const id = c.namedChild(0)
          if (id?.type === 'identifier') {
            if (spec === 'express') addFromExpress(id.text, 'namespace', 'namespace')
            else bindings.push({ local: id.text, specifier: spec, sel: 'namespace' })
          }
        } else if (c.type === 'named_imports') {
          for (let j = 0; j < c.namedChildCount; j++) {
            const s = c.namedChild(j)
            if (s?.type !== 'import_specifier') continue
            const name = s.childForFieldName('name')?.text
            if (!name) continue
            const local = s.childForFieldName('alias')?.text ?? name
            if (spec === 'express') addFromExpress(local, name, name)
            else bindings.push({ local, specifier: spec, sel: name })
          }
        }
      }
      return
    }

    if (node.type === 'variable_declarator') {
      const value = node.childForFieldName('value')
      if (value?.type !== 'call_expression') return
      const fn = value.childForFieldName('function')
      if (fn?.type !== 'identifier' || fn.text !== 'require') return
      const arg = namedArgs(value.childForFieldName('arguments'))[0]
      const spec = arg ? staticStringText(arg) : null
      if (!spec) return
      const name = node.childForFieldName('name')
      if (name?.type === 'identifier') {
        if (spec === 'express') expressLocals.add(name.text)
        else bindings.push({ local: name.text, specifier: spec, sel: 'default' }) // require = module.exports
      } else if (name?.type === 'object_pattern') {
        for (let i = 0; i < name.namedChildCount; i++) {
          const el = name.namedChild(i)
          if (!el) continue
          let local: string | undefined
          let exported: string | undefined
          if (el.type === 'shorthand_property_identifier_pattern') {
            local = el.text
            exported = el.text
          } else if (el.type === 'pair_pattern') {
            exported = el.childForFieldName('key')?.text
            local = el.childForFieldName('value')?.text ?? exported
          }
          if (!local || !exported) continue
          if (spec === 'express') addFromExpress(local, exported, exported)
          else bindings.push({ local, specifier: spec, sel: exported })
        }
      }
    }
  })

  return { expressLocals, routerCtors, bindings }
}

// Analyse one file's router topology: which vars are routers, what each mounts,
// which declare routes, and what the file exports.
function analyzeExpressFile(root: Parser.SyntaxNode, dir: string): FileRouterInfo {
  const { expressLocals, routerCtors, bindings } = collectExpressImports(root)
  const routerVars = new Map<string, RouterVarInfo>()
  const appVars = new Set<string>()
  const exportNamed = new Map<string, string>()
  let exportDefaultName: string | null = null

  const getVar = (name: string): RouterVarInfo => {
    let rv = routerVars.get(name)
    if (!rv) {
      rv = { declares: false, mounts: [] }
      routerVars.set(name, rv)
    }
    return rv
  }

  // Resolve an exported expression to a routerVars key. A bare identifier names
  // a var directly; a `Router().use(...)` chain becomes a synthetic entry keyed
  // `key`, so every export is expressible as a var reference.
  const refFromExpr = (expr: Parser.SyntaxNode, key: string): string | null => {
    if (expr.type === 'identifier') return expr.text
    const u = unwrapRouterExpr(expr, expressLocals, routerCtors)
    if (!u) return null
    const rv = getVar(key)
    for (const m of u.mounts) rv.mounts.push(m)
    if (typeof u.base === 'object') rv.aliasOf = u.base.alias
    return key
  }

  const isExported = (declarator: Parser.SyntaxNode): boolean => {
    const decl = declarator.parent // lexical_declaration / variable_declaration
    return decl?.parent?.type === 'export_statement'
  }

  walk(root, (node) => {
    if (node.type === 'variable_declarator') {
      const value = node.childForFieldName('value')
      const name = node.childForFieldName('name')
      if (name?.type !== 'identifier' || !value) return
      if (value.type === 'call_expression') {
        const fn = value.childForFieldName('function')
        if (fn?.type === 'identifier' && fn.text === 'require') return // an import, handled above
      }
      const u = unwrapRouterExpr(value, expressLocals, routerCtors)
      if (!u) return
      const rv = getVar(name.text)
      for (const m of u.mounts) rv.mounts.push(m)
      if (u.base === 'app') appVars.add(name.text)
      else if (typeof u.base === 'object') rv.aliasOf = u.base.alias
      if (isExported(node)) exportNamed.set(name.text, name.text)
      return
    }

    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function')
      if (fn?.type !== 'member_expression') return
      const obj = fn.childForFieldName('object')
      const prop = fn.childForFieldName('property')?.text
      if (obj?.type !== 'identifier' || !prop) return
      if (prop === 'use') {
        const m = parseUseMount(node)
        if (m) getVar(obj.text).mounts.push(m)
      } else if (ROUTER_METHODS.has(prop.toLowerCase())) {
        const first = namedArgs(node.childForFieldName('arguments'))[0]
        const p = first ? staticStringText(first) : null
        if (p !== null && p.startsWith('/')) getVar(obj.text).declares = true
      }
      return
    }

    if (node.type === 'export_statement') {
      // Named clause: `export { router, r as default }`.
      let clause: Parser.SyntaxNode | null = null
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i)
        if (c?.type === 'export_clause') clause = c
      }
      if (clause) {
        for (let i = 0; i < clause.namedChildCount; i++) {
          const spec = clause.namedChild(i)
          if (spec?.type !== 'export_specifier') continue
          const local = spec.childForFieldName('name')?.text
          if (!local) continue
          const exportedAs = spec.childForFieldName('alias')?.text ?? local
          if (exportedAs === 'default') exportDefaultName = local
          else exportNamed.set(exportedAs, local)
        }
        return
      }
      // `export const NAME = …` — the declarator handler registers it.
      if (node.childForFieldName('declaration')) return
      // `export default <expr>`.
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i)
        if (c && c.type !== 'export_clause') {
          exportDefaultName = refFromExpr(c, '#default')
          break
        }
      }
      return
    }

    if (node.type === 'assignment_expression') {
      const left = node.childForFieldName('left')
      const right = node.childForFieldName('right')
      if (left?.type !== 'member_expression' || !right) return
      const lobj = left.childForFieldName('object')?.text
      const lprop = left.childForFieldName('property')?.text
      if (lobj === 'module' && lprop === 'exports') exportDefaultName = refFromExpr(right, '#default')
      else if (lobj === 'exports' && lprop) {
        const key = refFromExpr(right, `#exp:${lprop}`)
        if (key) exportNamed.set(lprop, key)
      }
    }
  })

  return {
    dir,
    routerVars,
    appVars,
    exportDefaultName,
    exportNamed,
    rawBindings: bindings,
    importedRouters: new Map(),
  }
}

/**
 * Whole-program pass (ADR-160): compose Express cross-file mount prefixes onto
 * the routes they mount. Returns a map from a route-declaring file's
 * service-relative path to the prefix its routes serve under — e.g. a controller
 * mounted through `app.use(routes)` → `Router().use('/api', api)` → `.use(ctrl)`
 * lands `'/api'`. Files with no composed prefix are absent (their leaf paths
 * stand as declared). `files` should be the service's source files; only Express
 * `.js`/`.ts` files are analysed.
 */
export async function expressMountPrefixes(
  files: SourceFile[],
  serviceDir: string,
  tsPaths: TsPathConfig | null,
): Promise<Map<string, string>> {
  const jsParser = makeJsParser()
  const fileInfo = new Map<string, FileRouterInfo>()

  for (const f of files) {
    if (!JS_ROUTE_EXTENSIONS.has(path.extname(f.path))) continue
    if (isTestPath(f.path)) continue
    const rel = toPosix(path.relative(serviceDir, f.path))
    try {
      const tree = parseSource(jsParser, f.content)
      fileInfo.set(rel, analyzeExpressFile(tree.rootNode, path.dirname(f.path)))
    } catch {
      // A file that won't parse contributes no mounts; leave its routes bare.
    }
  }
  if (fileInfo.size === 0) return new Map()

  // Resolve each import binding to its defining file through the import graph —
  // the same specifier→file resolution imports.ts uses (ADR-149). A specifier
  // that leaves the service (node_modules, a Node builtin) resolves to null and
  // is dropped, so it can never carry a prefix.
  for (const info of fileInfo.values()) {
    for (const b of info.rawBindings) {
      const resolved = await resolveJsImport(b.specifier, info.dir, serviceDir, tsPaths)
      if (!resolved || !fileInfo.has(resolved)) continue
      info.importedRouters.set(b.local, { file: resolved, sel: b.sel === 'namespace' ? 'default' : b.sel })
    }
  }

  // Resolve a mounted identifier to (file, routerVars-key) — a local router var,
  // or a cross-file import's selected export. null when it names no router we can
  // reach, which leaves the leaf un-prefixed.
  const resolveTarget = (name: string, file: string): { file: string; name: string } | null => {
    const info = fileInfo.get(file)
    if (!info) return null
    if (info.routerVars.has(name)) return { file, name }
    const imp = info.importedRouters.get(name)
    if (!imp) return null
    const target = fileInfo.get(imp.file)
    if (!target) return null
    const key = imp.sel === 'default' ? target.exportDefaultName : target.exportNamed.get(imp.sel)
    if (!key) return null
    return { file: imp.file, name: key }
  }

  const filePrefix = new Map<string, string>()
  const conflicted = new Set<string>()
  const apply = (file: string, prefix: string): void => {
    if (conflicted.has(file)) return
    const existing = filePrefix.get(file)
    if (existing === undefined) filePrefix.set(file, prefix)
    else if (existing !== prefix) {
      // The same file reached at two different prefixes — genuinely ambiguous.
      // Drop it rather than pick one (ADR-160 discipline).
      filePrefix.delete(file)
      conflicted.add(file)
    }
  }

  const visited = new Set<string>()
  const collect = (file: string, name: string, accPrefix: string): void => {
    const key = `${file}|${name}|${accPrefix}`
    if (visited.has(key)) return
    visited.add(key)
    const info = fileInfo.get(file)
    const rv = info?.routerVars.get(name)
    if (!info || !rv) return
    // A file that also hosts an express() app serves its declared routes at the
    // app root; don't push a mount prefix onto them.
    if (rv.declares && info.appVars.size === 0) apply(file, accPrefix)
    for (const m of rv.mounts) {
      if (!m.target) continue
      const t = resolveTarget(m.target, file)
      if (t) collect(t.file, t.name, accPrefix + m.prefix)
    }
    if (rv.aliasOf) {
      const t = resolveTarget(rv.aliasOf, file)
      if (t) collect(t.file, t.name, accPrefix)
    }
  }

  // Root the walk at each express() app. What the app mounts is what the server
  // actually serves, so the prefix path from the app down is the real one.
  for (const [rel, info] of fileInfo) {
    for (const appVar of info.appVars) collect(rel, appVar, '')
  }

  const out = new Map<string, string>()
  for (const [file, prefix] of filePrefix) if (prefix && prefix !== '/') out.set(file, prefix)
  return out
}

// ── producer ────────────────────────────────────────────────────────────────

export async function addRoutes(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const jsParser = makeJsParser()
  const pyParser = makePyParser()
  const goParser = makeGoParser()
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
    const hasNestjs = deps['@nestjs/core'] !== undefined
    // FastAPI / Flask are discovered on a Python service the same dependency-gated
    // way: the manifest reader (extract/python.ts) strips the `fastapi[standard]`
    // extra to the bare `fastapi` distribution name.
    const hasFastapi = deps['fastapi'] !== undefined
    const hasFlask = deps['flask'] !== undefined
    const hasDjango = deps['django'] !== undefined
    const hasGin = deps['github.com/gin-gonic/gin'] !== undefined
    if (
      !hasExpress &&
      !hasFastify &&
      !hasHono &&
      !hasNext &&
      !hasNestjs &&
      !hasFastapi &&
      !hasFlask &&
      !hasDjango &&
      !hasGin
    )
      continue

    const files = await loadSourceFiles(service.dir)
    // Cross-file Express mount-prefix composition (ADR-160). Resolved once per
    // service after the file list is loaded; the per-file scan below prepends the
    // composed prefix so a mounted controller's leaf path (`/tags`) becomes the
    // full path a production span carries (`/api/tags`), and the two fuse.
    const mountPrefixes = hasExpress
      ? await expressMountPrefixes(files, service.dir, await loadTsPathConfig(service.dir))
      : new Map<string, string>()

    for (const file of files) {
      // ADR-065 #1 — test-scope exclusion. A test that spins up a router isn't
      // the service's declared route surface.
      if (isTestPath(file.path)) continue
      const ext = path.extname(file.path)
      const isPy = ext === '.py'
      const isGo = ext === '.go'
      if (!JS_ROUTE_EXTENSIONS.has(ext) && !isPy && !isGo) continue
      const relFile = toPosix(path.relative(service.dir, file.path))

      let routes: ExtractedRoute[]
      try {
        if (isGo) {
          routes = hasGin ? ginRoutesFromSource(file.content, goParser) : []
        } else if (isPy) {
          routes =
            hasFastapi || hasFlask
              ? pythonRoutesFromSource(file.content, pyParser, hasFastapi ? 'fastapi' : 'flask')
              : []
          // Django's URLconf shape (a urlpatterns list) is independent of the
          // decorator shape, so a Django service's routes come from here too.
          if (hasDjango) routes = routes.concat(djangoRoutesFromSource(file.content, pyParser))
        } else if (hasNext && (isNextAppRouteFile(relFile) || isNextPagesApiFile(relFile))) {
          routes = nextRoutesFromFile(file.content, relFile, jsParser)
        } else if (hasNestjs) {
          routes = nestjsRoutesFromSource(file.content, jsParser)
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

      // A cross-file Express mount prefix for this file's routes, if one resolved.
      const mountPrefix = mountPrefixes.get(relFile)

      for (const route of routes) {
        const pathTemplate = mountPrefix
          ? canonicalizeTemplate(mountPrefix + route.pathTemplate)
          : route.pathTemplate
        const rid = routeId(service.pkg.name, route.method, pathTemplate)
        if (!graph.hasNode(rid)) {
          const node: RouteNode = {
            id: rid,
            type: NodeType.RouteNode,
            name: `${route.method} ${pathTemplate}`,
            service: service.pkg.name,
            method: route.method,
            pathTemplate,
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
