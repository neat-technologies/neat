import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  passesExtractedFloor,
  serviceId,
} from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { isTestPath, makeEdgeId, urlMatchesHost, type DiscoveredService } from '../shared.js'
import { recordExtractionError, noteExtractedDropped } from '../errors.js'
import { normalizePathTemplate } from '../routes.js'
import {
  buildServiceHostIndex,
  ensureFileNode,
  loadSourceFiles,
  snippet,
  toPosix,
} from './shared.js'

// Cross-service contract matching (ADR-119). This is the bridge between the two
// static islands: a client call site names a URL (host + method + path); a
// server RouteNode (extracted by routes.ts) declares (method, path-template).
// When a client call's (host→service, method, normalised path) resolves to a
// server route, this producer mints a route-grained EXTRACTED CALLS edge from
// the client's FileNode to the server's RouteNode. It reuses the host→service
// resolution the HTTP producers share (buildServiceHostIndex / urlMatchesHost),
// adding path-template matching for the route half.
//
// The edge pairs with the OBSERVED server-span edge landing on the same
// RouteNode (#576), giving get_divergences a file-precise, two-sided comparison
// at route grain instead of only at service grain.
//
// Mainstream clients only: `fetch`, `axios` (default instance + method calls),
// and node `http`/`https` `.request`/`.get`. The host and path must sit in the
// same URL literal (or template literal) for a match — split base-URL + path
// across variables is out of scope for this slice.

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

const JS_CLIENT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])
const AXIOS_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request'])

export interface ClientCallSite {
  host: string // the known host the URL literal named (basename or pkg name)
  method?: string // upper-cased; undefined when not statically determinable
  pathTemplate: string // the URL path, with `:param` for interpolations
  line: number
  snippet: string
}

// ── AST helpers ─────────────────────────────────────────────────────────────

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node)
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child) walk(child, visit)
  }
}

// Reconstruct the URL text a string / template-string argument names. A template
// substitution (`${id}`) becomes the literal `:param` so the reconstructed URL
// is a valid string with a param-shaped path segment: `/users/${id}` →
// `/users/:param`. Returns null for anything that isn't a string-ish literal.
function reconstructUrl(node: Parser.SyntaxNode): string | null {
  if (node.type === 'string') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child?.type === 'string_fragment') return child.text
    }
    return ''
  }
  if (node.type === 'template_string') {
    let out = ''
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (!child) continue
      if (child.type === 'string_fragment') out += child.text
      else if (child.type === 'template_substitution') out += ':param'
    }
    // A template with no fragments/subs (empty) — fall back to stripped text.
    if (out.length === 0) {
      const raw = node.text
      return raw.length >= 2 ? raw.slice(1, -1) : ''
    }
    return out
  }
  return null
}

// Read the `method` string off an options / config object (`{ method: 'POST' }`).
function methodFromOptions(objNode: Parser.SyntaxNode): string | undefined {
  for (let i = 0; i < objNode.namedChildCount; i++) {
    const pair = objNode.namedChild(i)
    if (!pair || pair.type !== 'pair') continue
    const k = pair.childForFieldName('key')
    const kText = k ? (k.type === 'string' ? stringText(k) : k.text) : null
    if (kText !== 'method') continue
    const v = pair.childForFieldName('value')
    if (v && (v.type === 'string' || v.type === 'template_string')) {
      const s = stringText(v)
      return s ? s.toUpperCase() : undefined
    }
  }
  return undefined
}

function stringText(node: Parser.SyntaxNode): string | null {
  if (node.type === 'string') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child?.type === 'string_fragment') return child.text
    }
    return ''
  }
  return null
}

// The URL string a config object names (`axios({ url: '…', method })`).
function urlNodeFromConfig(objNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let i = 0; i < objNode.namedChildCount; i++) {
    const pair = objNode.namedChild(i)
    if (!pair || pair.type !== 'pair') continue
    const k = pair.childForFieldName('key')
    const kText = k ? (k.type === 'string' ? stringText(k) : k.text) : null
    if (kText === 'url') return pair.childForFieldName('value')
  }
  return null
}

// Parse the path out of a reconstructed URL string. Returns null when the string
// isn't URL-shaped (no scheme + host). `:param` in the path survives parsing.
function pathOf(urlStr: string): string | null {
  try {
    const candidate = urlStr.startsWith('//') ? `http:${urlStr}` : urlStr
    const parsed = new URL(candidate)
    return parsed.pathname || '/'
  } catch {
    return null
  }
}

// Resolve which known host a reconstructed URL names (ADR-065 #5 — scheme +
// exact hostname). Returns the host token or null.
function matchHost(urlStr: string, knownHosts: Set<string>): string | null {
  for (const host of knownHosts) {
    if (urlMatchesHost(urlStr, host)) return host
  }
  return null
}

// ── client call-site recognition ────────────────────────────────────────────

// Extract every recognised HTTP client call site whose URL literal names a
// known host. Each site carries the method (when statically determinable) and
// the path-template, ready to be matched against the server route table.
export function clientCallSitesFromSource(
  source: string,
  parser: Parser,
  knownHosts: Set<string>,
): ClientCallSite[] {
  const tree = parseSource(parser, source)
  const out: ClientCallSite[] = []

  const push = (
    urlNode: Parser.SyntaxNode,
    method: string | undefined,
    callNode: Parser.SyntaxNode,
  ): void => {
    const urlStr = reconstructUrl(urlNode)
    if (!urlStr) return
    const host = matchHost(urlStr, knownHosts)
    if (!host) return
    const p = pathOf(urlStr)
    if (p === null) return
    const line = callNode.startPosition.row + 1
    out.push({
      host,
      method,
      pathTemplate: p,
      line,
      snippet: snippet(source, line),
    })
  }

  walk(tree.rootNode, (node) => {
    if (node.type !== 'call_expression') return
    const fn = node.childForFieldName('function')
    if (!fn) return
    const args = node.childForFieldName('arguments')
    const first = args?.namedChild(0)
    if (!first) return

    // fetch(url, opts?) — global or member (globalThis.fetch).
    const fnName =
      fn.type === 'identifier'
        ? fn.text
        : fn.type === 'member_expression'
          ? (fn.childForFieldName('property')?.text ?? '')
          : ''

    if (fn.type === 'identifier' && fnName === 'fetch') {
      const opts = args?.namedChild(1)
      const method = opts && opts.type === 'object' ? (methodFromOptions(opts) ?? 'GET') : 'GET'
      push(first, method, node)
      return
    }

    // axios(url | config) — default instance called directly.
    if (fn.type === 'identifier' && fnName === 'axios') {
      if (first.type === 'object') {
        const urlNode = urlNodeFromConfig(first)
        if (urlNode) push(urlNode, methodFromOptions(first) ?? 'GET', node)
      } else {
        const opts = args?.namedChild(1)
        const method = opts && opts.type === 'object' ? (methodFromOptions(opts) ?? 'GET') : 'GET'
        push(first, method, node)
      }
      return
    }

    if (fn.type === 'member_expression') {
      const obj = fn.childForFieldName('object')
      const objName = obj?.text ?? ''

      // axios.get('/x') / axios.post('/x', body) / axios.request({ url, method }).
      if (objName === 'axios' && AXIOS_METHODS.has(fnName)) {
        if (fnName === 'request' && first.type === 'object') {
          const urlNode = urlNodeFromConfig(first)
          if (urlNode) push(urlNode, methodFromOptions(first) ?? 'GET', node)
        } else {
          push(first, fnName.toUpperCase(), node)
        }
        return
      }

      // node http/https .request(url, …) / .get(url, …).
      if ((objName === 'http' || objName === 'https') && (fnName === 'request' || fnName === 'get')) {
        const opts = args?.namedChild(1)
        const method =
          opts && opts.type === 'object'
            ? (methodFromOptions(opts) ?? (fnName === 'get' ? 'GET' : 'GET'))
            : 'GET'
        push(first, method, node)
        return
      }
    }
  })

  return out
}

// ── route index + matching ──────────────────────────────────────────────────

interface RouteEntry {
  method: string // upper, or 'ALL'
  normalizedPath: string
  routeNodeId: string
}

// Group every RouteNode in the graph by its owning ServiceNode id, keyed for
// (method, normalised-path) lookup. Built once per pass so client matching is a
// map read, not a graph scan per call site.
function buildRouteIndex(graph: NeatGraph): Map<string, RouteEntry[]> {
  const index = new Map<string, RouteEntry[]>()
  graph.forEachNode((_id, attrs) => {
    const node = attrs as unknown as { type?: string }
    if (node.type !== NodeType.RouteNode) return
    const route = attrs as unknown as RouteNode
    const owner = serviceId(route.service)
    const entry: RouteEntry = {
      method: route.method.toUpperCase(),
      normalizedPath: normalizePathTemplate(route.pathTemplate),
      routeNodeId: route.id,
    }
    const list = index.get(owner)
    if (list) list.push(entry)
    else index.set(owner, [entry])
  })
  return index
}

// A client call matches a route when the normalised paths agree and the methods
// are compatible: exact, or the route is method-agnostic (`ALL`), or the client
// method couldn't be read statically.
function findRoute(
  entries: RouteEntry[],
  method: string | undefined,
  normalizedPath: string,
): RouteEntry | undefined {
  return entries.find(
    (e) =>
      e.normalizedPath === normalizedPath &&
      (e.method === 'ALL' || method === undefined || e.method === method),
  )
}

export async function addRouteCallEdges(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const jsParser = makeJsParser()
  const { knownHosts, hostToNodeId } = buildServiceHostIndex(services)
  const routeIndex = buildRouteIndex(graph)
  if (routeIndex.size === 0) return { nodesAdded: 0, edgesAdded: 0 }

  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    const files = await loadSourceFiles(service.dir)
    // One edge per (client file, route) pair even if a file calls the route on
    // several lines (function grain is deferred, matching http.ts).
    const seen = new Set<string>()
    for (const file of files) {
      // ADR-065 #1 — test-scope exclusion.
      if (isTestPath(file.path)) continue
      if (!JS_CLIENT_EXTENSIONS.has(path.extname(file.path))) continue

      let sites: ClientCallSite[]
      try {
        sites = clientCallSitesFromSource(file.content, jsParser, knownHosts)
      } catch (err) {
        recordExtractionError('route-match call extraction', file.path, err)
        continue
      }
      if (sites.length === 0) continue

      const relFile = toPosix(path.relative(service.dir, file.path))
      for (const site of sites) {
        const serverServiceId = hostToNodeId.get(site.host)
        // Skip an unresolved host or a self-call (intra-service — no
        // cross-service contract to match, mirroring http.ts).
        if (!serverServiceId || serverServiceId === service.node.id) continue
        const entries = routeIndex.get(serverServiceId)
        if (!entries) continue
        const normalizedPath = normalizePathTemplate(site.pathTemplate)
        const match = findRoute(entries, site.method, normalizedPath)
        if (!match) continue

        const dedupKey = `${relFile}|${match.routeNodeId}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)

        // The matched call site is a parsed fact — the client FileNode and its
        // service ──CONTAINS──▶ file edge materialise regardless (file-awareness
        // §1). Only the file→route edge is gated by the precision floor.
        const { fileNodeId, nodesAdded: n, edgesAdded: e } = ensureFileNode(
          graph,
          service.pkg.name,
          service.node.id,
          relFile,
        )
        nodesAdded += n
        edgesAdded += e

        // A matched client↔route contract grades at verified-call-site (0.85):
        // both endpoints are recognised — a framework-aware client shape and a
        // parsed route definition — so it clears the floor and enters the graph
        // (ADR-119).
        const confidence = confidenceForExtracted('verified-call-site')
        const ev = {
          file: relFile,
          line: site.line,
          snippet: site.snippet,
          method: site.method ?? match.method,
          pathTemplate: site.pathTemplate,
        }
        if (!passesExtractedFloor(confidence)) {
          noteExtractedDropped({
            source: fileNodeId,
            target: match.routeNodeId,
            type: EdgeType.CALLS,
            confidence,
            confidenceKind: 'verified-call-site',
            evidence: ev,
          })
          continue
        }
        const edgeId = makeEdgeId(fileNodeId, match.routeNodeId, EdgeType.CALLS)
        if (!graph.hasEdge(edgeId)) {
          const edge: GraphEdge = {
            id: edgeId,
            source: fileNodeId,
            target: match.routeNodeId,
            type: EdgeType.CALLS,
            provenance: Provenance.EXTRACTED,
            confidence,
            evidence: ev,
          }
          graph.addEdgeWithKey(edgeId, fileNodeId, match.routeNodeId, edge)
          edgesAdded++
        }
      }
    }
  }

  return { nodesAdded, edgesAdded }
}
