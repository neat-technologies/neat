import path from 'node:path'
import Parser from 'tree-sitter'
import Java from 'tree-sitter-java'
import type { ExtractedConfidenceKind, GraphEdge, RouteNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  passesExtractedFloor,
  serviceId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { isTestPath, makeEdgeId, type DiscoveredService } from './shared.js'
import { recordExtractionError, noteExtractedDropped } from './errors.js'
import { buildServiceHostIndex, ensureFileNode, loadSourceFiles, snippet, toPosix } from './calls/shared.js'
import { normalizePathTemplate } from './routes.js'

// Outbound HTTP from Java services: Spring's RestTemplate and WebClient.
//
// A call's URL is rarely one literal. train-ticket, for one, writes
//   String url = getServiceUrl("ts-basic-service");     // returns "http://" + name
//   restTemplate.exchange(url + "/api/v1/basicservice/basic/travel", HttpMethod.POST, …)
// so the URL is resolved by evaluating the argument as a string expression:
// literals, `+`, same-file `static final String` constants, the enclosing
// method's local variables, and calls to a same-file helper whose body is a
// single `return` of the same kinds of pieces (inlined with its literal
// arguments). Any other piece — a runtime value, a getter, an injected `@Value`
// — becomes a `:param` path segment, or, in the host, leaves the host unknown.
//
// What it emits, the same shapes the JS/TS producers do:
//   - file ──CALLS──▶ service, when the host names a service in the graph
//     (http.ts's shape, graded verified-call-site: a client call wraps the URL);
//   - file ──CALLS──▶ route, when the path also matches one of that service's
//     RouteNodes (route-match.ts's shape and grading, ADR-119 / ADR-219).
// A call whose host can't be resolved stays unclaimed: the file still surfaces,
// and the call is recorded as a drop with its reason, never guessed.

const PARSE_CHUNK = 16384
// Stands for a piece of the URL that isn't known statically.
const HOLE = '\u0000'

const REST_TEMPLATE_METHODS: Record<string, string | null> = {
  getForObject: 'GET',
  getForEntity: 'GET',
  postForObject: 'POST',
  postForEntity: 'POST',
  postForLocation: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patchForObject: 'PATCH',
  // The HTTP method is the second argument.
  exchange: null,
  execute: null,
}
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])
const WEBCLIENT_VERBS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
  head: 'HEAD',
  options: 'OPTIONS',
}

export interface JavaCallSite {
  method?: string
  // The resolved host, or null when it couldn't be read statically.
  host: string | null
  // The path with `:param` for each unknown piece; '/' when the URL has none.
  pathTemplate: string
  approximate: boolean
  line: number
  reason?: string
}

function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) =>
    index >= source.length ? '' : source.slice(index, index + PARSE_CHUNK),
  )
}

function makeJavaParser(): Parser {
  const p = new Parser()
  p.setLanguage(Java)
  return p
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node)
  for (const c of node.namedChildren) walk(c, visit)
}

function stringLiteral(node: Parser.SyntaxNode): string | null {
  let out = ''
  for (const c of node.namedChildren) {
    if (c.type === 'string_fragment') out += c.text
    else return null
  }
  return out
}

interface Helper {
  params: string[]
  body: Parser.SyntaxNode
}

interface FileScope {
  constants: Map<string, Parser.SyntaxNode>
  helpers: Map<string, Helper>
}

// Same-file `static final` fields and single-return helper methods.
function fileScope(root: Parser.SyntaxNode): FileScope {
  const constants = new Map<string, Parser.SyntaxNode>()
  const helpers = new Map<string, Helper>()
  const dupHelpers = new Set<string>()
  walk(root, (n) => {
    if (n.type === 'field_declaration') {
      const mods = n.namedChildren.find((c) => c.type === 'modifiers')?.text ?? ''
      if (!/\bstatic\b/.test(mods) || !/\bfinal\b/.test(mods)) return
      for (const d of n.namedChildren) {
        if (d.type !== 'variable_declarator') continue
        const name = d.childForFieldName('name')?.text
        const value = d.childForFieldName('value')
        if (name && value) constants.set(name, value)
      }
    } else if (n.type === 'method_declaration') {
      const name = n.childForFieldName('name')?.text
      const body = n.childForFieldName('body')
      const params = n.childForFieldName('parameters')
      if (!name || !body || !params) return
      const stmts = body.namedChildren.filter((c) => c.type !== 'line_comment' && c.type !== 'block_comment')
      const ret = stmts.length === 1 && stmts[0]!.type === 'return_statement' ? stmts[0]!.namedChildren[0] : undefined
      if (!ret) return
      if (helpers.has(name)) dupHelpers.add(name) // overloads: ambiguous
      helpers.set(name, {
        params: params.namedChildren
          .filter((p) => p.type === 'formal_parameter')
          .map((p) => p.childForFieldName('name')?.text ?? ''),
        body: ret,
      })
    }
  })
  for (const name of dupHelpers) helpers.delete(name)
  return { constants, helpers }
}

// The enclosing method's locals: name → initializer, or null when assigned more
// than once (which value reaches the call isn't known statically).
function methodLocals(call: Parser.SyntaxNode): Map<string, Parser.SyntaxNode | null> {
  const out = new Map<string, Parser.SyntaxNode | null>()
  let m: Parser.SyntaxNode | null = call.parent
  while (m && m.type !== 'method_declaration' && m.type !== 'constructor_declaration' && m.type !== 'lambda_expression') {
    m = m.parent
  }
  const body = m?.childForFieldName('body')
  if (!body) return out
  walk(body, (n) => {
    if (n.type === 'local_variable_declaration') {
      for (const d of n.namedChildren) {
        if (d.type !== 'variable_declarator') continue
        const name = d.childForFieldName('name')?.text
        if (!name) continue
        out.set(name, out.has(name) ? null : d.childForFieldName('value'))
      }
    } else if (n.type === 'assignment_expression') {
      const left = n.childForFieldName('left')
      if (left?.type === 'identifier') out.set(left.text, null)
    }
  })
  return out
}

interface EvalCtx {
  scope: FileScope
  locals: Map<string, Parser.SyntaxNode | null>
  // Bound helper parameters while inlining.
  bound: Map<string, string>
  depth: number
}

// A string expression as text, with HOLE for each piece that isn't static.
function evalString(node: Parser.SyntaxNode, ctx: EvalCtx): string {
  if (ctx.depth > 8) return HOLE
  const next = (n: Parser.SyntaxNode, extra?: Partial<EvalCtx>): string =>
    evalString(n, { ...ctx, ...extra, depth: ctx.depth + 1 })
  switch (node.type) {
    case 'string_literal':
      return stringLiteral(node) ?? HOLE
    case 'parenthesized_expression':
      return node.namedChildren[0] ? next(node.namedChildren[0]) : HOLE
    case 'binary_expression': {
      if (node.childForFieldName('operator')?.text !== '+') return HOLE
      const l = node.childForFieldName('left')
      const r = node.childForFieldName('right')
      return (l ? next(l) : HOLE) + (r ? next(r) : HOLE)
    }
    case 'identifier': {
      const name = node.text
      if (ctx.bound.has(name)) return ctx.bound.get(name)!
      if (ctx.locals.has(name)) {
        const init = ctx.locals.get(name)
        return init ? next(init) : HOLE
      }
      const c = ctx.scope.constants.get(name)
      return c ? next(c, { locals: new Map(), bound: new Map() }) : HOLE
    }
    case 'method_invocation': {
      const obj = node.childForFieldName('object')
      if (obj && obj.type !== 'this') return HOLE
      const helper = ctx.scope.helpers.get(node.childForFieldName('name')?.text ?? '')
      const args = node.childForFieldName('arguments')?.namedChildren ?? []
      if (!helper || helper.params.length !== args.length) return HOLE
      const bound = new Map<string, string>()
      helper.params.forEach((p, i) => bound.set(p, next(args[i]!)))
      return next(helper.body, { locals: new Map(), bound })
    }
    default:
      return HOLE
  }
}

// Split an evaluated URL into host and path. A host is only taken from an
// `http(s)://` URL whose host part is fully static.
function splitUrl(url: string): { host: string | null; pathTemplate: string; approximate: boolean; reason?: string } {
  const approximate = url.includes(HOLE)
  const m = /^https?:\/\/([^/]*)(.*)$/.exec(url)
  if (!m) {
    return { host: null, pathTemplate: '/', approximate: true, reason: 'the URL has no static scheme and host' }
  }
  const hostPort = m[1]!
  if (!hostPort || hostPort.includes(HOLE)) {
    return { host: null, pathTemplate: '/', approximate: true, reason: 'the host is not static' }
  }
  const host = hostPort.replace(/:\d+$/, '')
  let p = (m[2] ?? '').split('?')[0]!.split('#')[0]!
  // A hole mid-segment (`/order/` + id) or as a whole segment is one param.
  p = p
    .split('/')
    .map((seg) => (seg.includes(HOLE) ? ':param' : seg))
    .join('/')
  if (!p.startsWith('/')) p = '/' + p
  return { host, pathTemplate: p, approximate }
}

function httpMethodArg(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node) return undefined
  const name = node.type === 'field_access' ? node.childForFieldName('field')?.text : node.text
  return name && HTTP_METHODS.has(name) ? name : undefined
}

// For `….get().uri(x)` / `….method(HttpMethod.X).uri(x)`: the verb in the chain.
function webClientMethod(uriCall: Parser.SyntaxNode): string | null {
  let cur: Parser.SyntaxNode | null = uriCall.childForFieldName('object')
  while (cur && cur.type === 'method_invocation') {
    const name = cur.childForFieldName('name')?.text ?? ''
    const args = cur.childForFieldName('arguments')?.namedChildren ?? []
    if (WEBCLIENT_VERBS[name] && args.length === 0) return WEBCLIENT_VERBS[name]!
    if (name === 'method') return httpMethodArg(args[0]) ?? null
    cur = cur.childForFieldName('object')
  }
  return null
}

// Names declared with type RestTemplate (fields, locals, parameters), so a
// `put` / `delete` on a map or a repository is never read as an HTTP call.
function restTemplateNames(root: Parser.SyntaxNode): Set<string> {
  const out = new Set<string>()
  walk(root, (n) => {
    if (n.type !== 'field_declaration' && n.type !== 'local_variable_declaration' && n.type !== 'formal_parameter') return
    const type = n.childForFieldName('type')?.text ?? ''
    if (!/(^|\.)RestTemplate$/.test(type)) return
    if (n.type === 'formal_parameter') {
      const name = n.childForFieldName('name')?.text
      if (name) out.add(name)
      return
    }
    for (const d of n.namedChildren) {
      if (d.type === 'variable_declarator') {
        const name = d.childForFieldName('name')?.text
        if (name) out.add(name)
      }
    }
  })
  return out
}

function isRestTemplateReceiver(obj: Parser.SyntaxNode | null, names: Set<string>): boolean {
  if (!obj) return false
  if (obj.type === 'identifier') return names.has(obj.text)
  if (obj.type === 'field_access' && obj.childForFieldName('object')?.type === 'this') {
    return names.has(obj.childForFieldName('field')?.text ?? '')
  }
  return false
}

/** RestTemplate / WebClient call sites in one Java source file. */
export function javaCallSitesFromSource(source: string, parser: Parser): JavaCallSite[] {
  const usesRestTemplate = source.includes('RestTemplate')
  const usesWebClient = source.includes('WebClient')
  if (!usesRestTemplate && !usesWebClient) return []
  const root = parseSource(parser, source).rootNode
  const scope = fileScope(root)
  const templates = usesRestTemplate ? restTemplateNames(root) : new Set<string>()
  const out: JavaCallSite[] = []

  walk(root, (n) => {
    if (n.type !== 'method_invocation') return
    const name = n.childForFieldName('name')?.text ?? ''
    const args = n.childForFieldName('arguments')?.namedChildren ?? []
    let method: string | undefined
    if (name in REST_TEMPLATE_METHODS && isRestTemplateReceiver(n.childForFieldName('object'), templates)) {
      method = REST_TEMPLATE_METHODS[name] ?? httpMethodArg(args[1])
      if (!method) return
    } else if (usesWebClient && name === 'uri') {
      const verb = webClientMethod(n)
      if (!verb) return
      method = verb
    } else {
      return
    }
    const urlNode = args[0]
    if (!urlNode) return
    const url = evalString(urlNode, { scope, locals: methodLocals(n), bound: new Map(), depth: 0 })
    out.push({ method, ...splitUrl(url), line: n.startPosition.row + 1 })
  })
  return out
}

interface RouteEntry {
  method: string
  normalizedPath: string
  routeNodeId: string
}

function buildRouteIndex(graph: NeatGraph): Map<string, RouteEntry[]> {
  const index = new Map<string, RouteEntry[]>()
  graph.forEachNode((_id, attrs) => {
    if ((attrs as { type?: string }).type !== NodeType.RouteNode) return
    const route = attrs as unknown as RouteNode
    const owner = serviceId(route.service)
    const list = index.get(owner) ?? []
    list.push({
      method: route.method.toUpperCase(),
      normalizedPath: normalizePathTemplate(route.pathTemplate),
      routeNodeId: route.id,
    })
    index.set(owner, list)
  })
  return index
}

// A path with at least one literal segment says which route it names.
function hasLiteralAnchor(pathTemplate: string): boolean {
  return pathTemplate.split('/').some((s) => s.length > 0 && s !== ':param')
}

/** File → service (and file → route) CALLS for Java RestTemplate / WebClient calls. */
export async function addJavaCallEdges(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const javaServices = services.filter((s) => s.node.language === 'java')
  if (javaServices.length === 0) return { nodesAdded: 0, edgesAdded: 0 }
  const parser = makeJavaParser()
  const { hostToNodeId } = buildServiceHostIndex(services)
  const routeIndex = buildRouteIndex(graph)
  let nodesAdded = 0
  let edgesAdded = 0

  const addEdge = (source: string, target: string, kind: ExtractedConfidenceKind, ev: GraphEdge['evidence']): void => {
    const confidence = confidenceForExtracted(kind)
    if (!passesExtractedFloor(confidence)) {
      noteExtractedDropped({ source, target, type: EdgeType.CALLS, confidence, confidenceKind: kind, evidence: ev! })
      return
    }
    const id = makeEdgeId(source, target, EdgeType.CALLS)
    if (graph.hasEdge(id)) return
    const edge: GraphEdge = {
      id,
      source,
      target,
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
      confidence,
      evidence: ev,
    }
    graph.addEdgeWithKey(id, source, target, edge)
    edgesAdded++
  }

  for (const service of javaServices) {
    const files = await loadSourceFiles(service.dir, service.excludeDirs)
    const seen = new Set<string>()
    for (const file of files) {
      if (path.extname(file.path) !== '.java' || isTestPath(file.path)) continue
      let sites: JavaCallSite[]
      try {
        sites = javaCallSitesFromSource(file.content, parser)
      } catch (err) {
        recordExtractionError('java http call extraction', file.path, err)
        continue
      }
      if (sites.length === 0) continue
      const relFile = toPosix(path.relative(service.dir, file.path))

      for (const site of sites) {
        const targetService = site.host === null ? undefined : hostToNodeId.get(site.host)
        // A literal host outside the graph (a third party, or a service not in
        // this scan) is skipped, as http.ts skips it.
        if (site.host !== null && !targetService) continue
        if (targetService === service.node.id) continue

        const { fileNodeId, nodesAdded: n, edgesAdded: e } = ensureFileNode(
          graph,
          service.pkg.name,
          service.node.id,
          relFile,
        )
        nodesAdded += n
        edgesAdded += e
        const ev = {
          file: relFile,
          line: site.line,
          snippet: snippet(file.content, site.line),
          method: site.method,
          pathTemplate: site.pathTemplate,
        }

        if (!targetService) {
          const key = `${relFile}|unresolved|${site.line}`
          if (seen.has(key)) continue
          seen.add(key)
          noteExtractedDropped({
            source: fileNodeId,
            target: 'route:unresolved',
            type: EdgeType.CALLS,
            confidence: confidenceForExtracted('reconstructed-approximate'),
            confidenceKind: 'reconstructed-approximate',
            evidence: { ...ev, approximate: true, reason: site.reason },
          })
          continue
        }

        if (!seen.has(`${relFile}|${targetService}`)) {
          seen.add(`${relFile}|${targetService}`)
          addEdge(fileNodeId, targetService, 'verified-call-site', ev)
        }

        const route = routeIndex
          .get(targetService)
          ?.find(
            (r) =>
              r.normalizedPath === normalizePathTemplate(site.pathTemplate) &&
              (r.method === 'ALL' || site.method === undefined || r.method === site.method),
          )
        if (!route || seen.has(`${relFile}|${route.routeNodeId}`)) continue
        seen.add(`${relFile}|${route.routeNodeId}`)
        const anchored = hasLiteralAnchor(site.pathTemplate)
        addEdge(
          fileNodeId,
          route.routeNodeId,
          site.approximate && !anchored ? 'reconstructed-approximate' : 'verified-call-site',
          site.approximate && !anchored ? { ...ev, approximate: true, reason: 'no literal path segment' } : ev,
        )
      }
    }
  }

  return { nodesAdded, edgesAdded }
}
