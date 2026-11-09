import path from 'node:path'
import Parser from 'tree-sitter'
import Python from 'tree-sitter-python'
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
import { canonicalizeTemplate, type ExtractedRoute } from './routes.js'

// Tornado route extraction. A Tornado app declares its routes as a literal
// handler table passed to `Application`:
//
//   tornado.web.Application([
//       (r"/getVoucher", GetVoucherHandler),
//       url(r"/orders/(?P<id>[0-9]+)", OrderHandler, name="order"),
//   ])
//
// Each entry's path pattern becomes a RouteNode, with one route per HTTP verb
// method (`get`, `post`, …) the handler class defines in the same file; a
// handler defined elsewhere gives one `ALL` route. The table may be inline,
// passed as `handlers=[…]`, or a same-file list variable.
//
// A pattern is a regex. Each capture group becomes a param segment (`:id` for a
// named group, `:param` otherwise), a leading `^` and trailing `$` or `/?` are
// dropped, and a pattern that still carries regex syntax after that is left
// unclaimed rather than guessed. Gated on the service's `tornado` dependency.

const PARSE_CHUNK = 16384
const VERBS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']

function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) =>
    index >= source.length ? '' : source.slice(index, index + PARSE_CHUNK),
  )
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node)
  for (const c of node.namedChildren) walk(c, visit)
}

// A plain (raw or not) string literal's text; null for an f-string or a
// concatenation.
function pyString(node: Parser.SyntaxNode | undefined): string | null {
  if (!node || node.type !== 'string') return null
  let out = ''
  for (const c of node.namedChildren) {
    if (c.type === 'string_content') out += c.text
    else if (c.type === 'interpolation') return null
  }
  return out
}

/** A Tornado URL regex as a path template; null when it isn't one. */
export function tornadoPathTemplate(pattern: string): string | null {
  let p = pattern.replace(/^\^/, '').replace(/\$$/, '').replace(/\/\?$/, '')
  p = p.replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>[^()]*\)/g, ':$1')
  p = p.replace(/\((?!\?)[^()]*\)/g, ':param')
  if (/[\\()[\]{}*+?|^$]/.test(p)) return null
  return canonicalizeTemplate(p || '/')
}

// The verb methods each same-file class defines.
function handlerVerbs(root: Parser.SyntaxNode): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const c of root.namedChildren) {
    const cls = c.type === 'decorated_definition' ? c.childForFieldName('definition') : c
    if (cls?.type !== 'class_definition') continue
    const name = cls.childForFieldName('name')?.text
    const body = cls.childForFieldName('body')
    if (!name || !body) continue
    const verbs: string[] = []
    for (const m of body.namedChildren) {
      const fn = m.type === 'decorated_definition' ? m.childForFieldName('definition') : m
      const fname = fn?.type === 'function_definition' ? fn.childForFieldName('name')?.text : undefined
      if (fname && VERBS.includes(fname)) verbs.push(fname.toUpperCase())
    }
    out.set(name, verbs)
  }
  return out
}

// Same-file `name = [...]` list assignments, for a handler table passed by name.
function listVariables(root: Parser.SyntaxNode): Map<string, Parser.SyntaxNode | null> {
  const out = new Map<string, Parser.SyntaxNode | null>()
  walk(root, (n) => {
    if (n.type !== 'assignment') return
    const left = n.childForFieldName('left')
    const right = n.childForFieldName('right')
    if (left?.type !== 'identifier') return
    out.set(left.text, out.has(left.text) ? null : right?.type === 'list' ? right : null)
  })
  return out
}

function isApplicationCall(call: Parser.SyntaxNode): boolean {
  const fn = call.childForFieldName('function')
  const name = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : fn?.text
  return name === 'Application'
}

/** Tornado routes declared in one Python source file. */
export function tornadoRoutesFromSource(source: string, parser: Parser): ExtractedRoute[] {
  const root = parseSource(parser, source).rootNode
  const verbs = handlerVerbs(root)
  const lists = listVariables(root)
  const out: ExtractedRoute[] = []

  walk(root, (call) => {
    if (call.type !== 'call' || !isApplicationCall(call)) return
    const args = call.childForFieldName('arguments')?.namedChildren ?? []
    let table: Parser.SyntaxNode | null | undefined = args.find((a) => a.type !== 'keyword_argument')
    for (const a of args) {
      if (a.type === 'keyword_argument' && a.childForFieldName('name')?.text === 'handlers') {
        table = a.childForFieldName('value')
      }
    }
    if (table?.type === 'identifier') table = lists.get(table.text) ?? null
    if (!table || table.type !== 'list') return

    for (const entry of table.namedChildren) {
      // `(pattern, Handler, …)` or `url(pattern, Handler, …)` / `URLSpec(…)`.
      let parts: Parser.SyntaxNode[] = []
      if (entry.type === 'tuple') parts = entry.namedChildren
      else if (entry.type === 'call') {
        const fn = entry.childForFieldName('function')
        const fname = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : fn?.text
        if (fname !== 'url' && fname !== 'URLSpec') continue
        parts = (entry.childForFieldName('arguments')?.namedChildren ?? []).filter((a) => a.type !== 'keyword_argument')
      } else continue
      const pattern = pyString(parts[0])
      const handler = parts[1]
      if (pattern === null || !handler) continue
      const pathTemplate = tornadoPathTemplate(pattern)
      if (!pathTemplate) continue
      const handlerName = handler.type === 'attribute' ? handler.childForFieldName('attribute')?.text : handler.text
      const methods = (handlerName && verbs.get(handlerName)?.length ? verbs.get(handlerName)! : ['ALL'])
      for (const method of methods) {
        out.push({ method, pathTemplate, line: entry.startPosition.row + 1, framework: 'tornado' })
      }
    }
  })
  return out
}

/** Mint Tornado RouteNodes for every service that depends on tornado. */
export async function addTornadoRoutes(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let parser: Parser | null = null
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    const deps = { ...(service.pkg.dependencies ?? {}), ...(service.pkg.devDependencies ?? {}) }
    if (deps['tornado'] === undefined) continue
    parser ??= (() => {
      const p = new Parser()
      p.setLanguage(Python)
      return p
    })()
    const files = await loadSourceFiles(service.dir, service.excludeDirs)
    for (const file of files) {
      if (path.extname(file.path) !== '.py' || isTestPath(file.path)) continue
      if (!file.content.includes('Application')) continue
      let routes: ExtractedRoute[]
      try {
        routes = tornadoRoutesFromSource(file.content, parser)
      } catch (err) {
        recordExtractionError('route extraction', file.path, err)
        continue
      }
      const relFile = toPosix(path.relative(service.dir, file.path))
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
        const containsId = extractedEdgeId(service.node.id, rid, EdgeType.CONTAINS)
        if (!graph.hasEdge(containsId)) {
          const edge: GraphEdge = {
            id: containsId,
            source: service.node.id,
            target: rid,
            type: EdgeType.CONTAINS,
            provenance: Provenance.EXTRACTED,
            confidence: confidenceForExtracted('structural'),
            evidence: { file: relFile, line: route.line, snippet: snippet(file.content, route.line) },
          }
          graph.addEdgeWithKey(containsId, service.node.id, rid, edge)
          edgesAdded++
        }
      }
    }
  }

  return { nodesAdded, edgesAdded }
}
