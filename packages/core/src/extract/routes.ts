import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import Python from 'tree-sitter-python'
import Go from 'tree-sitter-go'
import Ruby from 'tree-sitter-ruby'
import Php from 'tree-sitter-php'
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

function makeRubyParser(): Parser {
  const p = new Parser()
  p.setLanguage(Ruby)
  return p
}

// Laravel's route files are pure PHP (a controller + route definitions, no HTML
// islands), so the grammar's `php_only` variant is the right parser — `.php`
// would accept `?>`-delimited HTML the route files never carry (ADR-177).
function makePhpParser(): Parser {
  const p = new Parser()
  p.setLanguage(Php.php_only)
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
  // The route's `controller#action` handler, when the recogniser knows it —
  // Rails' resourceful expansion derives it (ADR-173). RouteNode carries no
  // handler field today, so `addRoutes` keeps this off the graph; it exists so
  // the recogniser tests can assert the module/pluralisation logic the path
  // template alone can't show (a `scope module:` route differs only here).
  controller?: string
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

// ── Rails config/routes.rb routes (ADR-173) ─────────────────────────────────
//
// Reads a Rails router table out of `config/routes.rb` and emits a RouteNode per
// (HTTP method, path template). Explicit verb routes and `root` are read from
// the source directly; `resources`/`resource` fan out through Rails' resourceful
// expansion, `namespace`/`scope` contribute a path and/or a controller-module
// prefix, `member`/`collection` add routes to the enclosing resource, and one
// level of nesting stamps the parent's `:<singular>_id` param onto the child.
//
// The declared template keeps Rails' `:id` form verbatim: the action_pack OTel
// instrumentation (Rails ≥ 7.1) sets `http.route` to exactly that string with
// the trailing `(.:format)` stripped, and `normalizePathTemplate` already
// collapses every `:word` segment to `:param`, so a route-grain server span
// fuses onto this node with no normalisation. What can't be resolved statically
// — routes.rb metaprogramming, `draw(:file)` split files, mounted engines,
// `constraints`, nesting past one level — is left out rather than guessed; those
// routes still appear at runtime, as an honest observed-but-not-declared
// divergence rather than a wrong RouteNode.

const RAILS_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head'])

// The member routes a `resources` (plural) declaration fans out to. `update`
// lands on both PATCH and PUT — Rails registers both and a runtime request can
// carry either. `new`/`edit` are the form-rendering GETs.
interface ResourceRow {
  action: string
  methods: string[]
  suffix: string
}
const RAILS_PLURAL_ROWS: ResourceRow[] = [
  { action: 'index', methods: ['GET'], suffix: '' },
  { action: 'new', methods: ['GET'], suffix: '/new' },
  { action: 'create', methods: ['POST'], suffix: '' },
  { action: 'show', methods: ['GET'], suffix: '/:id' },
  { action: 'edit', methods: ['GET'], suffix: '/:id/edit' },
  { action: 'update', methods: ['PATCH', 'PUT'], suffix: '/:id' },
  { action: 'destroy', methods: ['DELETE'], suffix: '/:id' },
]
// The singular `resource` set — no index and no `:id` segment (there is only ever
// one), and the controller is pluralised (`resource :profile` → `profiles`).
const RAILS_SINGULAR_ROWS: ResourceRow[] = [
  { action: 'new', methods: ['GET'], suffix: '/new' },
  { action: 'create', methods: ['POST'], suffix: '' },
  { action: 'show', methods: ['GET'], suffix: '' },
  { action: 'edit', methods: ['GET'], suffix: '/edit' },
  { action: 'update', methods: ['PATCH', 'PUT'], suffix: '' },
  { action: 'destroy', methods: ['DELETE'], suffix: '' },
]

// Minimal English inflection — enough for the common resource names. Rails uses
// ActiveSupport's fuller irregular table; a resource's own path segments are the
// literal symbol it declares, so only the derived controller name and the nested
// `:<singular>_id` param depend on this — and the param name never affects fusion
// (`normalizePathTemplate` collapses any `:word` to `:param`). Irregular plurals
// (person/people) are a later refinement, not a fusion risk.
function railsPluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es'
  return word + 's'
}
function railsSingularize(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + 'y'
  if (/(x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2)
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1)
  return word
}

// The interior text of a Ruby string literal, or a symbol's name without its
// leading colon (`:orders` → 'orders'). Returns null for an interpolated string
// (it carries a child that isn't `string_content`) — a route path or handler is
// a static literal.
function rubyLiteral(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null
  if (node.type === 'simple_symbol') return node.text.replace(/^:/, '')
  if (node.type === 'string') {
    let text = ''
    let sawContent = false
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (!child) continue
      if (child.type === 'string_content' || child.type === 'escape_sequence') {
        text += child.text
        sawContent = true
      } else {
        return null // interpolation or anything non-literal
      }
    }
    return sawContent ? text : '' // an empty string literal has no content child
  }
  return null
}

function rubyArgs(call: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return call.childForFieldName('arguments')
}

// The positional (non-`pair`) arguments of a call, in order.
function rubyPositional(args: Parser.SyntaxNode | null): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  if (!args) return out
  for (let i = 0; i < args.namedChildCount; i++) {
    const c = args.namedChild(i)
    if (c && c.type !== 'pair') out.push(c)
  }
  return out
}

// The value node of a keyword argument `key: …` — a `pair` whose key is a
// `hash_key_symbol` with the given name.
function rubyKwarg(args: Parser.SyntaxNode | null, key: string): Parser.SyntaxNode | null {
  if (!args) return null
  for (let i = 0; i < args.namedChildCount; i++) {
    const pair = args.namedChild(i)
    if (!pair || pair.type !== 'pair') continue
    const k = pair.childForFieldName('key')
    if (k?.type === 'hash_key_symbol' && k.text === key) return pair.childForFieldName('value')
  }
  return null
}

function rubyKwargText(args: Parser.SyntaxNode | null, key: string): string | null {
  return rubyLiteral(rubyKwarg(args, key))
}

// The hash-rocket verb shorthand `get 'path' => 'controller#action'` — a `pair`
// whose key is a string literal. Returns the path and the handler target.
function rubyRocketRoute(
  args: Parser.SyntaxNode | null,
): { path: string; target: string | null } | null {
  if (!args) return null
  for (let i = 0; i < args.namedChildCount; i++) {
    const pair = args.namedChild(i)
    if (!pair || pair.type !== 'pair') continue
    const k = pair.childForFieldName('key')
    if (k?.type !== 'string') continue
    const path = rubyLiteral(k)
    if (path === null) continue
    return { path, target: rubyLiteral(pair.childForFieldName('value')) }
  }
  return null
}

// The statement `call` nodes directly inside a `do … end` block. tree-sitter-ruby
// wraps multiple statements in a `body_statement`; fall back to the block's own
// direct children for the single-statement shape.
function rubyBlockCalls(block: Parser.SyntaxNode | null): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  if (!block) return out
  const pushCalls = (n: Parser.SyntaxNode): void => {
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i)
      if (c?.type === 'call') out.push(c)
    }
  }
  let sawBody = false
  for (let i = 0; i < block.namedChildCount; i++) {
    const c = block.namedChild(i)
    if (c?.type === 'body_statement') {
      pushCalls(c)
      sawBody = true
    }
  }
  if (!sawBody) pushCalls(block)
  return out
}

// Join an accumulated prefix with a leaf path, tolerating a leading slash on the
// leaf. `canonicalizeTemplate` finishes the job (leading slash, no trailing).
function railsJoin(prefix: string, leaf: string): string {
  return prefix + '/' + leaf.replace(/^\/+/, '')
}

function railsEmit(
  out: ExtractedRoute[],
  method: string,
  rawPath: string,
  controller: string | null,
  line: number,
): void {
  out.push({
    method,
    pathTemplate: canonicalizeTemplate(rawPath === '' ? '/' : rawPath),
    line,
    framework: 'rails',
    ...(controller ? { controller } : {}),
  })
}

// `only:` / `except:` restrict a resource's emitted action set. A value is a
// single symbol (`except: :destroy`) or an array (`only: [:index, :show]`).
function railsActionFilter(args: Parser.SyntaxNode | null): (action: string) => boolean {
  const collect = (key: string): Set<string> | null => {
    const val = rubyKwarg(args, key)
    if (!val) return null
    const set = new Set<string>()
    if (val.type === 'array') {
      for (let i = 0; i < val.namedChildCount; i++) {
        const name = rubyLiteral(val.namedChild(i))
        if (name) set.add(name)
      }
    } else {
      const name = rubyLiteral(val)
      if (name) set.add(name)
    }
    return set
  }
  const only = collect('only')
  const except = collect('except')
  return (action: string) =>
    (only ? only.has(action) : true) && (except ? !except.has(action) : true)
}

// A bare `get :recent` verb inside a resource block — emits one route relative to
// `pathBase` (a member path carries `:id`, a collection path does not).
function railsSingleVerb(
  verb: Parser.SyntaxNode,
  pathBase: string,
  controller: string,
  out: ExtractedRoute[],
): void {
  const vm = verb.childForFieldName('method')?.text
  if (!vm || !RAILS_VERBS.has(vm)) return
  const action = rubyLiteral(rubyPositional(rubyArgs(verb))[0])
  if (action === null) return
  railsEmit(out, vm.toUpperCase(), railsJoin(pathBase, action), `${controller}#${action}`, verb.startPosition.row + 1)
}

// The `member do … end` / `collection do … end` verb lists inside a resource.
function railsBlockVerbs(
  call: Parser.SyntaxNode,
  pathBase: string,
  controller: string,
  out: ExtractedRoute[],
): void {
  for (const verb of rubyBlockCalls(call.childForFieldName('block'))) {
    railsSingleVerb(verb, pathBase, controller, out)
  }
}

interface RailsCtx {
  path: string // accumulated path prefix, '' at the draw root, no trailing slash
  module: string // accumulated controller-module prefix, '' or e.g. 'admin/'
  depth: number // resource-nesting depth; 0 at the top level
}

// An explicit verb route: `get '/x', to: 'c#a'`, the hash-rocket `get 'x' => 'c#a'`,
// or a bare `get 'about'` (handler inferred `about#index`-style).
function railsVerbRoute(
  call: Parser.SyntaxNode,
  method: string,
  ctx: RailsCtx,
  out: ExtractedRoute[],
  line: number,
): void {
  const args = rubyArgs(call)
  let rawPath: string | null
  let target: string | null
  const rocket = rubyRocketRoute(args)
  if (rocket) {
    rawPath = rocket.path
    target = rocket.target
  } else {
    rawPath = rubyLiteral(rubyPositional(args)[0])
    target = rubyKwargText(args, 'to')
  }
  if (rawPath === null) return
  if (target === null) target = railsInferHandler(rawPath)
  railsEmit(out, method, railsJoin(ctx.path, rawPath), target ? ctx.module + target : null, line)
}

// Infer a `controller#action` for a bare verb route with no `to:`: a single
// segment maps to `<segment>#index`, a multi-segment path splits the last off as
// the action. Handler metadata only — the path template is what fuses.
function railsInferHandler(rawPath: string): string {
  const segs = rawPath
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter((s) => s.length > 0 && !s.startsWith(':'))
  if (segs.length === 0) return 'index'
  if (segs.length === 1) return `${segs[0]}#index`
  return `${segs.slice(0, -1).join('/')}#${segs[segs.length - 1]}`
}

// `resources :orders` (plural) / `resource :profile` (singular) — Rails'
// resourceful expansion, plus the resource's own `member`/`collection`/nested
// block. One level of nesting is composed; deeper nesting is deferred.
function railsResource(
  call: Parser.SyntaxNode,
  ctx: RailsCtx,
  out: ExtractedRoute[],
  plural: boolean,
): void {
  if (ctx.depth >= 2) return // one level of nesting only (ADR-173)
  const args = rubyArgs(call)
  const name = rubyLiteral(rubyPositional(args)[0])
  if (!name) return
  const base = `${ctx.path}/${name}`
  const controller = ctx.module + (plural ? name : railsPluralize(name))
  const allow = railsActionFilter(args)
  const line = call.startPosition.row + 1

  for (const row of plural ? RAILS_PLURAL_ROWS : RAILS_SINGULAR_ROWS) {
    if (!allow(row.action)) continue
    for (const m of row.methods) railsEmit(out, m, base + row.suffix, `${controller}#${row.action}`, line)
  }

  const block = call.childForFieldName('block')
  if (!block) return
  const memberBase = plural ? `${base}/:id` : base // a singular member has no :id
  const nestedPath = plural ? `${base}/:${railsSingularize(name)}_id` : base
  for (const child of rubyBlockCalls(block)) {
    const cm = child.childForFieldName('method')?.text
    if (cm === 'member') railsBlockVerbs(child, memberBase, controller, out)
    else if (cm === 'collection') railsBlockVerbs(child, base, controller, out)
    else if (cm && RAILS_VERBS.has(cm)) railsSingleVerb(child, base, controller, out)
    else if (cm === 'resources' || cm === 'resource' || cm === 'namespace' || cm === 'scope') {
      railsProcess([child], { path: nestedPath, module: ctx.module, depth: ctx.depth + 1 }, out)
    }
    // concerns, member-less helpers, etc. — deferred
  }
}

// Walk a list of routes.rb statements in a routing context, dispatching each
// `call` on its method name.
function railsProcess(statements: Parser.SyntaxNode[], ctx: RailsCtx, out: ExtractedRoute[]): void {
  for (const call of statements) {
    const method = call.childForFieldName('method')?.text
    if (!method) continue
    const args = rubyArgs(call)
    const line = call.startPosition.row + 1

    if (method === 'root') {
      const target = rubyKwargText(args, 'to') ?? rubyLiteral(rubyPositional(args)[0])
      railsEmit(out, 'GET', ctx.path || '/', target ? ctx.module + target : null, line)
      continue
    }
    if (RAILS_VERBS.has(method)) {
      railsVerbRoute(call, method.toUpperCase(), ctx, out, line)
      continue
    }
    if (method === 'resources' || method === 'resource') {
      railsResource(call, ctx, out, method === 'resources')
      continue
    }
    if (method === 'namespace') {
      const name = rubyLiteral(rubyPositional(args)[0])
      if (!name) continue
      railsProcess(rubyBlockCalls(call.childForFieldName('block')), {
        path: `${ctx.path}/${name}`,
        module: `${ctx.module}${name}/`,
        depth: ctx.depth,
      }, out)
      continue
    }
    if (method === 'scope') {
      // A positional string/symbol scopes the path; `path:`/`module:` scope each
      // axis explicitly. A `scope module: 'admin'` shifts only the controller
      // module, leaving the URL unchanged — the case only the handler shows.
      const scopePath = rubyKwargText(args, 'path') ?? rubyLiteral(rubyPositional(args)[0])
      const scopeModule = rubyKwargText(args, 'module')
      railsProcess(rubyBlockCalls(call.childForFieldName('block')), {
        path: scopePath ? railsJoin(ctx.path, scopePath) : ctx.path,
        module: scopeModule ? `${ctx.module}${scopeModule}/` : ctx.module,
        depth: ctx.depth,
      }, out)
      continue
    }
    // mount, constraints, `%i[…].each { resources … }`, concerns — deferred.
  }
}

// Read `config/routes.rb`: find the `Rails.application.routes.draw do … end`
// block and expand its body. `draw(:file)` split-route files carry no block and
// are deferred.
export function railsRoutesFromSource(source: string, parser: Parser): ExtractedRoute[] {
  const tree = parseSource(parser, source)
  const out: ExtractedRoute[] = []
  walk(tree.rootNode, (node) => {
    if (node.type !== 'call') return
    if (node.childForFieldName('method')?.text !== 'draw') return
    const block = node.childForFieldName('block')
    if (!block) return
    railsProcess(rubyBlockCalls(block), { path: '', module: '', depth: 0 }, out)
  })
  return out
}

// ── Laravel routes/web.php + routes/api.php (ADR-177) ───────────────────────
//
// Reads a Laravel router table out of `routes/web.php` and `routes/api.php` and
// emits a RouteNode per (HTTP method, path template). Explicit verb routes
// (`Route::get('/orders/{id}', …)`) are read from the source directly;
// `Route::resource`/`apiResource` fan out through Laravel's resourceful
// convention; `Route::prefix('admin')->group(…)` (and the `middleware`,
// `controller`, `name` group forms) compose a path prefix across nesting; and
// every route in `routes/api.php` gets the automatic `/api` prefix the framework
// adds (it isn't in the source), passed in as the base prefix.
//
// The declared template keeps Laravel's `{id}` form verbatim: Laravel's
// OpenTelemetry auto-instrumentation sets `http.route` to exactly the templated
// URI (`orders/{id}` for a request to `/orders/42`), and `normalizePathTemplate`
// already drops the leading slash and collapses every `{…}` segment to `:param`,
// so a route-grain server span fuses onto this node with no ingest change.
//
// Deferred (ADR-177): Symfony entirely — its OTel emits the route NAME, not the
// path, so it needs a distinct extractor + ingest name-join; `config/routes.yaml`;
// controller-array handler resolution beyond the template; `match`, `redirect`,
// `view`, `fallback`, singleton and domain routing; and resource `->only`/`->except`
// filtering. Those routes surface as observed-but-not-declared divergence rather
// than a fabricated node.

const LARAVEL_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options'])

// The rows a `Route::resource` fans out to — Laravel's convention, reimplemented
// (it isn't in the source text). `{param}` is the singularized resource name;
// `update` lands on both PUT and PATCH, since Laravel registers both and a
// runtime request can carry either. `apiResource` drops the two form-rendering
// GETs (`create`, `edit`).
interface LaravelResourceRow {
  action: string
  methods: string[]
  suffix: string
}
const LARAVEL_RESOURCE_ROWS: LaravelResourceRow[] = [
  { action: 'index', methods: ['GET'], suffix: '' },
  { action: 'create', methods: ['GET'], suffix: '/create' },
  { action: 'store', methods: ['POST'], suffix: '' },
  { action: 'show', methods: ['GET'], suffix: '/{param}' },
  { action: 'edit', methods: ['GET'], suffix: '/{param}/edit' },
  { action: 'update', methods: ['PUT', 'PATCH'], suffix: '/{param}' },
  { action: 'destroy', methods: ['DELETE'], suffix: '/{param}' },
]
const LARAVEL_API_RESOURCE_SKIP = new Set(['create', 'edit'])

// A deliberately simple singularizer — strip one trailing `s`. The resource param
// is DISPLAY ONLY: `normalizePathTemplate` collapses every `{…}` segment to
// `:param` before fusion, so `{photo}` vs `{photos}` never changes the matching
// key (ADR-177). Reproducing Laravel's fuller inflection isn't a fusion
// requirement, so the cheap rule stands.
function laravelSingularize(word: string): string {
  return word.endsWith('s') ? word.slice(0, -1) : word
}

// The interior text of a PHP single-quoted `string` or double-quoted
// `encapsed_string`, or null when it carries interpolation (a route path is a
// static literal). An empty literal returns ''.
function phpStaticString(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null
  if (node.type !== 'string' && node.type !== 'encapsed_string') return null
  let text = ''
  let sawContent = false
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (!child) continue
    if (child.type === 'string_content') {
      text += child.text
      sawContent = true
    } else {
      return null // interpolation / escape / anything non-literal
    }
  }
  return sawContent ? text : ''
}

// The value nodes of a call's positional arguments. tree-sitter-php wraps each in
// an `argument`; the value is its last named child (a PHP-8 named argument
// `name: value` carries a `name` field that precedes the value).
function phpArgumentValues(argsNode: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  if (!argsNode) return out
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const arg = argsNode.namedChild(i)
    if (!arg || arg.type !== 'argument') continue
    const val = arg.namedChild(arg.namedChildCount - 1)
    if (val) out.push(val)
  }
  return out
}

// The first positional argument as a static string (the route path / resource
// name), or null.
function phpFirstString(argsNode: Parser.SyntaxNode | null | undefined): string | null {
  const vals = phpArgumentValues(argsNode)
  return vals.length > 0 ? phpStaticString(vals[0]) : null
}

// Join path parts into a canonical `/`-leading, no-trailing-slash template,
// trimming any embedded leading/trailing slashes on each part (Laravel's own
// prefix-composition discipline). An empty set of parts is the root, `/`.
function laravelJoinPath(...parts: string[]): string {
  const segs: string[] = []
  for (const part of parts) {
    for (const s of part.split('/')) {
      if (s.length > 0) segs.push(s)
    }
  }
  return '/' + segs.join('/')
}

interface LaravelSeg {
  method: string
  args: Parser.SyntaxNode | null
  node: Parser.SyntaxNode
}

// Flatten a `Route::…->…->…` fluent chain into its ordered (method, args)
// segments, innermost first. `Route::prefix('admin')->group(fn)` →
// [prefix, group]; a bare `Route::get('/x')` → [get]. Returns null when the chain
// doesn't root at the `Route` facade (bare, leading-backslash, or the
// fully-qualified `Illuminate\Support\Facades\Route`).
function laravelUnrollChain(node: Parser.SyntaxNode): LaravelSeg[] | null {
  const segs: LaravelSeg[] = []
  let cur: Parser.SyntaxNode | null = node
  while (cur && cur.type === 'member_call_expression') {
    const name = cur.childForFieldName('name')?.text
    if (!name) return null
    segs.unshift({ method: name, args: cur.childForFieldName('arguments'), node: cur })
    cur = cur.childForFieldName('object')
  }
  if (!cur || cur.type !== 'scoped_call_expression') return null
  const method = cur.childForFieldName('name')?.text
  if (!method) return null
  segs.unshift({ method, args: cur.childForFieldName('arguments'), node: cur })
  const scopeText = cur.childForFieldName('scope')?.text ?? ''
  const rooted = scopeText === 'Route' || scopeText.endsWith('\\Route')
  return rooted ? segs : null
}

// The closure a `->group(…)` call carries — a `function () { … }`
// (`anonymous_function_creation_expression`) or a `fn () => …` (`arrow_function`).
function laravelGroupClosure(argsNode: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  for (const v of phpArgumentValues(argsNode)) {
    if (v.type === 'anonymous_function_creation_expression' || v.type === 'arrow_function') return v
  }
  return null
}

// The route-call statements inside a group closure body — a `{ … }` block of
// `expression_statement`s, or a single-expression arrow body.
function laravelClosureCalls(closure: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  const push = (n: Parser.SyntaxNode | null): void => {
    if (n && (n.type === 'member_call_expression' || n.type === 'scoped_call_expression')) out.push(n)
  }
  const body = closure.childForFieldName('body')
  if (!body) return out
  if (closure.type === 'arrow_function') {
    push(body)
    return out
  }
  for (let i = 0; i < body.namedChildCount; i++) {
    const stmt = body.namedChild(i)
    if (stmt?.type === 'expression_statement') push(stmt.namedChild(0))
  }
  return out
}

function laravelEmit(out: ExtractedRoute[], method: string, rawPath: string, line: number): void {
  // An optional param `{id?}` drops its `?` so the stored template stays clean —
  // `canonicalizeTemplate` reads a literal `?` as a query-string delimiter and
  // would truncate `/users/{id?}` to `/users/{id`. Fusion is unaffected either
  // way (`normalizePathTemplate` collapses every `{…}` segment to `:param`); this
  // only keeps the declared template readable and honest.
  const cleaned = rawPath.replace(/\{([^}?]+)\?\}/g, '{$1}')
  out.push({
    method,
    pathTemplate: canonicalizeTemplate(cleaned === '' ? '/' : cleaned),
    line,
    framework: 'laravel',
  })
}

// `Route::resource('photos', …)` / `apiResource` — Laravel's resourceful
// expansion. A dotted name (`photos.comments`) composes into a nested path with
// the parent param stamped on (`/photos/{photo}/comments/{comment}`), best-effort.
function laravelResource(
  seg: LaravelSeg,
  prefix: string,
  out: ExtractedRoute[],
  api: boolean,
): void {
  const name = phpFirstString(seg.args)
  if (name === null || name.length === 0) return
  const line = seg.node.startPosition.row + 1
  const parts = name.split('.')
  const leaf = parts[parts.length - 1]!
  let base = prefix
  for (let i = 0; i < parts.length - 1; i++) {
    base = laravelJoinPath(base, parts[i]!, `{${laravelSingularize(parts[i]!)}}`)
  }
  base = laravelJoinPath(base, leaf)
  const param = laravelSingularize(leaf)
  for (const row of LARAVEL_RESOURCE_ROWS) {
    if (api && LARAVEL_API_RESOURCE_SKIP.has(row.action)) continue
    const suffix = row.suffix.replace('{param}', `{${param}}`)
    const template = laravelJoinPath(base, suffix)
    for (const m of row.methods) laravelEmit(out, m, template, line)
  }
}

// Process one `Route::…` statement in a routing context (the accumulated path
// prefix). A `->group(…)` composes its `prefix('x')` contributions onto the
// prefix and recurses into the closure; a verb emits a route; `any` is a
// method-agnostic `ALL`; `resource`/`apiResource` fan out. Per-route modifiers
// chained after a verb (`->name(…)`, `->where(…)`, `->middleware(…)`) don't
// change the template, so they fall out — the verb sits at the base of the chain.
function laravelProcessCall(callNode: Parser.SyntaxNode, prefix: string, out: ExtractedRoute[]): void {
  const segs = laravelUnrollChain(callNode)
  if (!segs) return

  const groupSeg = segs.find((s) => s.method === 'group')
  if (groupSeg) {
    let composed = prefix
    for (const s of segs) {
      if (s === groupSeg) break
      if (s.method === 'prefix') {
        const p = phpFirstString(s.args)
        if (p !== null) composed = laravelJoinPath(composed, p)
      }
    }
    const closure = laravelGroupClosure(groupSeg.args)
    if (!closure) return
    for (const child of laravelClosureCalls(closure)) {
      laravelProcessCall(child, composed, out)
    }
    return
  }

  const base = segs[0]!
  const line = base.node.startPosition.row + 1
  if (LARAVEL_VERBS.has(base.method)) {
    const p = phpFirstString(base.args)
    if (p === null) return
    laravelEmit(out, base.method.toUpperCase(), laravelJoinPath(prefix, p), line)
    return
  }
  if (base.method === 'any') {
    const p = phpFirstString(base.args)
    if (p === null) return
    laravelEmit(out, 'ALL', laravelJoinPath(prefix, p), line)
    return
  }
  if (base.method === 'resource' || base.method === 'apiResource') {
    laravelResource(base, prefix, out, base.method === 'apiResource')
  }
}

// Read `routes/web.php` (no prefix) or `routes/api.php` (`basePrefix` = '/api',
// the framework's automatic prefix, not in the source). Walk the top-level route
// statements; groups nest and are recursed into explicitly.
export function laravelRoutesFromSource(
  source: string,
  parser: Parser,
  basePrefix = '',
): ExtractedRoute[] {
  const tree = parseSource(parser, source)
  const out: ExtractedRoute[] = []
  const root = tree.rootNode
  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i)
    if (stmt?.type !== 'expression_statement') continue
    const call = stmt.namedChild(0)
    if (call && (call.type === 'member_call_expression' || call.type === 'scoped_call_expression')) {
      laravelProcessCall(call, basePrefix, out)
    }
  }
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
  const rubyParser = makeRubyParser()
  const phpParser = makePhpParser()
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
    // Rails is discovered from the Gemfile (extract/ruby.ts) the same
    // dependency-gated way; its routes live in one conventional file (ADR-173).
    const hasRails = deps['rails'] !== undefined
    // Laravel is discovered from composer.json (extract/php.ts) the same
    // dependency-gated way; its routes live in routes/web.php + api.php (ADR-177).
    const hasLaravel = deps['laravel/framework'] !== undefined
    if (
      !hasExpress &&
      !hasFastify &&
      !hasHono &&
      !hasNext &&
      !hasNestjs &&
      !hasFastapi &&
      !hasFlask &&
      !hasDjango &&
      !hasGin &&
      !hasRails &&
      !hasLaravel
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
      const isRb = ext === '.rb'
      const isPhp = ext === '.php'
      if (!JS_ROUTE_EXTENSIONS.has(ext) && !isPy && !isGo && !isRb && !isPhp) continue
      const relFile = toPosix(path.relative(service.dir, file.path))

      let routes: ExtractedRoute[]
      try {
        if (isPhp) {
          // Laravel declares its HTTP surface in two conventional files; every
          // route in routes/api.php gets the framework's automatic `/api` prefix
          // (not in the source), passed as the base prefix. Other `.php` files
          // carry no routes to read (ADR-177).
          routes =
            hasLaravel && (relFile === 'routes/web.php' || relFile === 'routes/api.php')
              ? laravelRoutesFromSource(
                  file.content,
                  phpParser,
                  relFile === 'routes/api.php' ? '/api' : '',
                )
              : []
        } else if (isRb) {
          // Rails declares its whole route table in one conventional file; other
          // `.rb` files carry no routes to read (ADR-173).
          routes =
            hasRails && relFile === 'config/routes.rb'
              ? railsRoutesFromSource(file.content, rubyParser)
              : []
        } else if (isGo) {
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
