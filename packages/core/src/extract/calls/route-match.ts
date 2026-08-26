import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import type { ExtractedConfidenceKind, GraphEdge, RouteNode } from '@neat.is/types'
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
  // The known host the URL named (basename or pkg name), or null when the base
  // URL was an interpolation we couldn't resolve — an approximate call site with
  // no resolvable target (ADR-219).
  host: string | null
  method?: string // upper-cased; undefined when not statically determinable
  pathTemplate: string // the URL path, with `:param` for unresolved interpolations; '' when the host is unresolved
  line: number
  snippet: string
  // Reconstruction fidelity (ADR-219). True when a load-bearing interpolation in
  // the URL couldn't be resolved statically, so any match rests on shape rather
  // than literal evidence.
  approximate: boolean
  reason?: string // why the reconstruction was approximated (diagnostic)
}

// ── AST helpers ─────────────────────────────────────────────────────────────

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node)
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child) walk(child, visit)
  }
}

// Resolve an expression node to a static string when the file alone determines
// it: a string / no-substitution template literal, an identifier bound to one
// earlier in the file, or the literal side of a `||` / `??` default (the
// `process.env.X || 'http://localhost'` shape). Returns null for anything
// computed at runtime. This is what turns an interpolated base URL held in a
// `const` back into a real host instead of a `:param` (ADR-219).
function resolveStaticString(
  node: Parser.SyntaxNode | null,
  constMap: Map<string, string>,
  depth = 0,
): string | null {
  if (!node || depth > 4) return null
  if (node.type === 'string') return stringText(node)
  if (node.type === 'template_string') {
    let out = ''
    let sawSub = false
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (!child) continue
      if (child.type === 'string_fragment') out += child.text
      else if (child.type === 'template_substitution') sawSub = true
    }
    return sawSub ? null : out
  }
  if (node.type === 'identifier') return constMap.get(node.text) ?? null
  if (node.type === 'binary_expression') {
    // `a || b` / `a ?? b` — take whichever side resolves. Covers an env read
    // with a literal dev default, where the literal is the statically-known value.
    const left = resolveStaticString(node.childForFieldName('left'), constMap, depth + 1)
    if (left !== null) return left
    return resolveStaticString(node.childForFieldName('right'), constMap, depth + 1)
  }
  if (node.type === 'parenthesized_expression') {
    return resolveStaticString(node.namedChild(0), constMap, depth + 1)
  }
  return null
}

// Build identifier → static-string bindings from the file's declarations, so an
// interpolated base URL held in a variable (`const API_BASE = 'http://api'`) can
// be substituted back into the URL. Document-order pass; later writes win. This
// deliberately doesn't model block scope or reassignment — the target is the
// common module-level base-URL const, not a general dataflow.
function collectStaticStringBindings(root: Parser.SyntaxNode): Map<string, string> {
  const map = new Map<string, string>()
  walk(root, (node) => {
    if (node.type !== 'variable_declarator') return
    const name = node.childForFieldName('name')
    if (!name || name.type !== 'identifier') return
    const resolved = resolveStaticString(node.childForFieldName('value'), map)
    if (resolved !== null) map.set(name.text, resolved)
  })
  return map
}

// Reconstruct the URL text a string / template-string argument names, resolving
// interpolations back to their static values where the file determines them (a
// base URL held in a const, ADR-219). A substitution that stays unresolvable
// becomes `:param` and marks the result approximate: `/users/${id}` →
// `/users/:param` (approximate), `${API_BASE}/x` with `API_BASE` a const → the
// real base + `/x` (exact). Returns null for anything that isn't a string-ish
// literal.
function reconstructUrl(
  node: Parser.SyntaxNode,
  constMap: Map<string, string>,
): { url: string; approximate: boolean } | null {
  if (node.type === 'string') {
    const s = stringText(node)
    return s === null ? null : { url: s, approximate: false }
  }
  if (node.type === 'template_string') {
    let out = ''
    let approximate = false
    let sawPart = false
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (!child) continue
      if (child.type === 'string_fragment') {
        out += child.text
        sawPart = true
      } else if (child.type === 'template_substitution') {
        sawPart = true
        const resolved = resolveStaticString(child.namedChild(0), constMap)
        if (resolved !== null) out += resolved
        else {
          out += ':param'
          approximate = true
        }
      }
    }
    // A template with no fragments/subs (empty) — fall back to stripped text.
    if (!sawPart) {
      const raw = node.text
      return { url: raw.length >= 2 ? raw.slice(1, -1) : '', approximate: false }
    }
    return { url: out, approximate }
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

// Whether the authority (host[:port]) slot of a reconstructed URL is an
// unresolved interpolation rather than a literal host. Distinguishes a base URL
// that couldn't be resolved (`:param/charges`, `${base}` unresolved) — which we
// surface as an approximate diagnostic — from a literal external host that
// simply isn't one of our services (`https://stripe.com/${id}`), which stays a
// silent skip (ADR-219).
function hostSlotUnresolved(url: string): boolean {
  const schemeRel = url.indexOf('//')
  let authority: string
  if (schemeRel >= 0) {
    const rest = url.slice(schemeRel + 2)
    const slash = rest.indexOf('/')
    authority = slash >= 0 ? rest.slice(0, slash) : rest
  } else {
    const slash = url.indexOf('/')
    authority = slash >= 0 ? url.slice(0, slash) : url
  }
  return authority.length === 0 || authority.includes(':param')
}

// Whether a reconstructed path carries at least one literal segment to anchor
// which route it names. A path that is entirely dynamic once normalised — a lone
// `/:param` from a computed first segment — matches any same-arity `/:id` route
// with no literal evidence, so it must not mint a confident edge (ADR-219). A
// literal segment (`/charges/:param`) pins the match to a specific route family.
function pathHasLiteralAnchor(pathTemplate: string): boolean {
  const segs = normalizePathTemplate(pathTemplate)
    .split('/')
    .filter((s) => s.length > 0)
  if (segs.length === 0) return false
  return segs.some((s) => s !== ':param')
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
  // File-level static bindings, so an interpolated base URL held in a const
  // resolves back to its real host instead of collapsing to `:param` (ADR-219).
  const constMap = collectStaticStringBindings(tree.rootNode)

  const push = (
    urlNode: Parser.SyntaxNode,
    method: string | undefined,
    callNode: Parser.SyntaxNode,
  ): void => {
    const rec = reconstructUrl(urlNode, constMap)
    if (!rec) return
    const line = callNode.startPosition.row + 1
    const host = matchHost(rec.url, knownHosts)
    if (host === null) {
      // No known host resolved. When the authority itself was an unresolved
      // interpolation, surface it as an approximate call site — never a silent
      // drop (ADR-219). A literal external host that just isn't one of our
      // services stays a silent skip.
      if (rec.approximate && hostSlotUnresolved(rec.url)) {
        out.push({
          host: null,
          method,
          pathTemplate: '',
          line,
          snippet: snippet(source, line),
          approximate: true,
          reason: 'base URL interpolation could not be resolved statically',
        })
      }
      return
    }
    const p = pathOf(rec.url)
    if (p === null) return
    out.push({
      host,
      method,
      pathTemplate: p,
      line,
      snippet: snippet(source, line),
      approximate: rec.approximate,
      reason: rec.approximate
        ? 'path segment interpolation could not be resolved statically'
        : undefined,
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
    const files = await loadSourceFiles(service.dir, service.excludeDirs)
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
        // An unresolved base URL has no host to attribute the call to. It is
        // still a recognised call site (file-awareness §1), so materialise the
        // file and record an approximate drop — visible under the rejected log /
        // diagnostic floor, never a silent miss (ADR-219).
        if (site.host === null) {
          const dedupKey = `${relFile}|unresolved-host`
          if (seen.has(dedupKey)) continue
          seen.add(dedupKey)
          const { fileNodeId, nodesAdded: n, edgesAdded: e } = ensureFileNode(
            graph,
            service.pkg.name,
            service.node.id,
            relFile,
          )
          nodesAdded += n
          edgesAdded += e
          noteExtractedDropped({
            source: fileNodeId,
            target: 'route:unresolved',
            type: EdgeType.CALLS,
            confidence: confidenceForExtracted('reconstructed-approximate'),
            confidenceKind: 'reconstructed-approximate',
            evidence: {
              file: relFile,
              line: site.line,
              snippet: site.snippet,
              method: site.method,
              approximate: true,
              reason: site.reason,
            },
          })
          continue
        }

        const serverServiceId = hostToNodeId.get(site.host)
        // Skip a self-call (intra-service — no cross-service contract to match,
        // mirroring http.ts).
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

        // Reconstruction-fidelity grade (ADR-219). A fully-resolved URL — literal,
        // or with every interpolation resolved from scope — grades
        // verified-call-site (0.85): both endpoints are recognised and the client
        // URL is faithful. A URL that stayed approximate keeps that grade only
        // when a literal path segment anchors which route it names
        // (`/charges/:param`); an all-dynamic path (`/:param` from a computed
        // segment) has no literal evidence of the target and grades
        // reconstructed-approximate, below the precision floor — refused under the
        // default floor, visible with its reason when the floor is lowered.
        const anchored = pathHasLiteralAnchor(site.pathTemplate)
        const confidenceKind: ExtractedConfidenceKind =
          site.approximate && !anchored ? 'reconstructed-approximate' : 'verified-call-site'
        const confidence = confidenceForExtracted(confidenceKind)
        const ev = {
          file: relFile,
          line: site.line,
          snippet: site.snippet,
          method: site.method ?? match.method,
          pathTemplate: site.pathTemplate,
          ...(confidenceKind === 'reconstructed-approximate'
            ? { approximate: true, reason: site.reason }
            : {}),
        }
        if (!passesExtractedFloor(confidence)) {
          noteExtractedDropped({
            source: fileNodeId,
            target: match.routeNodeId,
            type: EdgeType.CALLS,
            confidence,
            confidenceKind,
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
