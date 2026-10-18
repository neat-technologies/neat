import path from 'node:path'
import Parser from 'tree-sitter'
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
import {
  buildServiceHostIndex,
  ensureFileNode,
  loadSourceFiles,
  snippet,
  toPosix,
} from './calls/shared.js'
import { normalizePathTemplate } from './routes.js'
import { SYMBOL_GRAMMAR_BY_EXT, parseSource } from './symbols.js'

// Outbound HTTP from C# services: System.Net.Http `HttpClient`. A call names its
// target through the request method and the URL — `client.GetAsync("http://cart/api/x")`,
// `PostAsync` / `PutAsync` / `DeleteAsync` / `PatchAsync` and the `*AsJsonAsync`
// extensions, the `GetStringAsync` / `GetByteArrayAsync` / `GetStreamAsync` shortcuts.
// Each resolved call becomes:
//   - file ──CALLS──▶ service, when the URL's host names a service in the graph
//     (buildServiceHostIndex, the same host→service map every HTTP recogniser uses)
//   - file ──CALLS──▶ route, when the path also matches one of that service's routes
// the same shape java-calls.ts mints for RestTemplate / WebClient (ADR-119 topology).
//
// First cut, precision-first: the URL is read only when it is a single string literal.
// An absolute literal (`http(s)://host/path`) resolves host + path; anything built at
// runtime — a `BaseAddress` + relative path (the typed-client shape), string
// interpolation, `+` concatenation, a const or helper — is left unclaimed rather than
// guessed. Cross-reference of a named `AddHttpClient(...)` BaseAddress to its relative
// calls, and the Refit interface shape, are named follow-ons.

const METHOD_BY_CALL: Record<string, string> = {
  GetAsync: 'GET',
  GetStringAsync: 'GET',
  GetByteArrayAsync: 'GET',
  GetStreamAsync: 'GET',
  PostAsync: 'POST',
  PostAsJsonAsync: 'POST',
  PutAsync: 'PUT',
  PutAsJsonAsync: 'PUT',
  DeleteAsync: 'DELETE',
  PatchAsync: 'PATCH',
  PatchAsJsonAsync: 'PATCH',
}
const MARKER = /HttpClient|System\.Net\.Http|\.(Get|Post|Put|Delete|Patch)(Async|AsJsonAsync)\s*\(/

interface CsharpCallSite {
  host: string | null
  pathTemplate: string
  method: string
  line: number
}

// The first plain string literal's value inside a node (interpolated strings aren't
// `string_literal`, so a `$"…"` URL returns undefined and is left unclaimed).
function firstStringLiteral(node: Parser.SyntaxNode): string | undefined {
  if (node.type === 'string_literal') {
    const content = node.namedChildren.find((c) => c.type === 'string_literal_content')
    return content ? content.text : node.text.replace(/^[@$]*"/, '').replace(/"$/, '')
  }
  for (const c of node.namedChildren) {
    const v = firstStringLiteral(c)
    if (v !== undefined) return v
  }
  return undefined
}

// Host + path from a literal URL. An absolute `http(s)://` URL gives both; a relative
// path (a BaseAddress call) gives a path with an unknown host, which the producer
// can't tie to a service, so it is not emitted in this cut.
function urlParts(literal: string): { host: string; path: string } | null {
  if (!/^https?:\/\//i.test(literal)) return null
  try {
    const u = new URL(literal)
    return { host: u.hostname, path: u.pathname || '/' }
  } catch {
    return null
  }
}

export function csharpCallSitesFromSource(content: string, root: Parser.SyntaxNode): CsharpCallSite[] {
  const out: CsharpCallSite[] = []
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'invocation_expression') {
      const fn = node.childForFieldName('function')
      if (fn?.type === 'member_access_expression') {
        const name = fn.childForFieldName('name')?.text ?? ''
        const method = METHOD_BY_CALL[name]
        if (method) {
          const firstArg = node.childForFieldName('arguments')?.namedChildren[0]
          const literal = firstArg ? firstStringLiteral(firstArg) : undefined
          const parts = literal !== undefined ? urlParts(literal) : null
          if (parts) {
            out.push({ host: parts.host, pathTemplate: parts.path, method, line: node.startPosition.row + 1 })
          }
        }
      }
    }
    for (const c of node.namedChildren) visit(c)
  }
  visit(root)
  return out
}

interface RouteRow {
  normalizedPath: string
  method: string
  routeNodeId: string
}

function buildRouteIndex(graph: NeatGraph): Map<string, RouteRow[]> {
  const idx = new Map<string, RouteRow[]>()
  graph.forEachNode((id, a) => {
    const n = a as RouteNode & { type: string }
    if (n.type !== NodeType.RouteNode) return
    const svc = serviceId(n.service)
    const list = idx.get(svc) ?? []
    list.push({ normalizedPath: normalizePathTemplate(n.pathTemplate), method: n.method, routeNodeId: id })
    idx.set(svc, list)
  })
  return idx
}

/** File → service (and file → route) CALLS for C# HttpClient calls. */
export async function addCsharpCallEdges(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const csharpServices = services.filter((s) => s.node.language === 'csharp')
  if (csharpServices.length === 0) return { nodesAdded: 0, edgesAdded: 0 }
  const grammar = SYMBOL_GRAMMAR_BY_EXT['.cs']
  if (!grammar) return { nodesAdded: 0, edgesAdded: 0 }
  const parser = new Parser()
  parser.setLanguage(grammar)
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
    graph.addEdgeWithKey(id, source, target, {
      id,
      source,
      target,
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
      confidence,
      evidence: ev,
    })
    edgesAdded++
  }

  for (const service of csharpServices) {
    const files = await loadSourceFiles(service.dir, service.excludeDirs)
    const seen = new Set<string>()
    for (const file of files) {
      if (path.extname(file.path) !== '.cs' || isTestPath(file.path)) continue
      if (!MARKER.test(file.content)) continue
      let sites: CsharpCallSite[]
      try {
        sites = csharpCallSitesFromSource(file.content, parseSource(parser, file.content).rootNode)
      } catch (err) {
        recordExtractionError('csharp http call extraction', file.path, err)
        continue
      }
      if (sites.length === 0) continue
      const relFile = toPosix(path.relative(service.dir, file.path))

      for (const site of sites) {
        const targetService = site.host === null ? undefined : hostToNodeId.get(site.host)
        if (!targetService || targetService === service.node.id) continue // third party or self

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

        if (!seen.has(`${relFile}|${targetService}`)) {
          seen.add(`${relFile}|${targetService}`)
          addEdge(fileNodeId, targetService, 'verified-call-site', ev)
        }

        const route = routeIndex
          .get(targetService)
          ?.find(
            (r) =>
              r.normalizedPath === normalizePathTemplate(site.pathTemplate) &&
              (r.method === 'ALL' || r.method === site.method),
          )
        if (!route || seen.has(`${relFile}|${route.routeNodeId}`)) continue
        seen.add(`${relFile}|${route.routeNodeId}`)
        addEdge(fileNodeId, route.routeNodeId, 'verified-call-site', ev)
      }
    }
  }

  return { nodesAdded, edgesAdded }
}
