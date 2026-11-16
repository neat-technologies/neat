import path from 'node:path'
import Parser from 'tree-sitter'
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
import { SYMBOL_GRAMMAR_BY_EXT, parseSource } from './symbols.js'

// ASP.NET Core route extraction — the C# rung of the route producer family beside
// java-routes.ts (Spring) and routes.ts (the JS/Python/Go/… routers). A C# HTTP
// surface is declared two ways, both read here:
//
//   - Attribute controllers: a class carries `[Route("api/[controller]")]`, each
//     action an `[HttpGet]` / `[HttpPost]` / `[HttpPut]` / `[HttpDelete]` /
//     `[HttpPatch]` (optionally with a template `[HttpGet("{id}")]`), or a bare
//     `[Route("x")]` on the method (any verb → `ALL`). The class prefix composes
//     with the method template, `[controller]` expands to the class name without its
//     `Controller` suffix and `[action]` to the method name — ASP.NET's own tokens.
//   - Minimal API: `app.MapGet("/path", …)` / `MapPost` / `MapPut` / `MapDelete` /
//     `MapPatch` with a literal path.
//
// Each (method, path) pair becomes a RouteNode owned by its service through
// `service ──CONTAINS──▶ route`, the same shape every other router mints (ADR-119),
// so an ASP.NET SERVER span's `http.route` fuses onto it.
//
// Precision, never a guess: a method template that is interpolated (`$"…"`) or built
// at runtime yields no literal and is skipped; a minimal-API path that isn't a
// literal starting with `/` is skipped (so a non-ASP.NET `.MapGet("key")` can't mint
// a phantom route); a `[controller]`-less class with no `[Route]` and an attributeless
// action has only a convention-derived route NEAT can't know, and is left unclaimed.

const VERB_ATTR: Record<string, string> = {
  httpget: 'GET',
  httppost: 'POST',
  httpput: 'PUT',
  httpdelete: 'DELETE',
  httppatch: 'PATCH',
  httphead: 'HEAD',
  httpoptions: 'OPTIONS',
}
const MAP_VERB: Record<string, string> = {
  MapGet: 'GET',
  MapPost: 'POST',
  MapPut: 'PUT',
  MapDelete: 'DELETE',
  MapPatch: 'PATCH',
}
// Cheap pre-check: a file with none of these can't declare an ASP.NET route.
const ASPNET_MARKER =
  /Microsoft\.AspNetCore|\[Http|\[ApiController|ControllerBase|\[Route|\.Map(Get|Post|Put|Delete|Patch)\b/

// The first *plain* string literal value inside a node — the interpolated-string node
// type isn't `string_literal`, so an interpolated template returns undefined and is
// left unclaimed rather than minting a route with a C# `{expr}` hole in it.
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

// The attribute's name, last dotted segment (`[Microsoft.AspNetCore.Mvc.HttpGet]` → `HttpGet`).
function attrName(attr: Parser.SyntaxNode): string {
  const n = attr.childForFieldName('name')?.text ?? ''
  return n.slice(n.lastIndexOf('.') + 1)
}

// Compose a class prefix and a method template. A method template that is absolute
// (`/x` or `~/x`) overrides the class prefix, as ASP.NET routing does.
function joinRoute(prefix: string | undefined, leaf: string | undefined): string | undefined {
  if (leaf !== undefined && (leaf.startsWith('/') || leaf.startsWith('~/'))) {
    return leaf.replace(/^~/, '')
  }
  if (prefix !== undefined && leaf !== undefined) return `${prefix}/${leaf}`
  return leaf ?? prefix
}

function expandTokens(tpl: string, controller: string, action: string): string {
  return tpl.replace(/\[controller\]/gi, controller).replace(/\[action\]/gi, action)
}

function classLevelRoute(cls: Parser.SyntaxNode): string | undefined {
  for (const al of cls.namedChildren) {
    if (al.type !== 'attribute_list') continue
    for (const a of al.namedChildren) {
      if (a.type === 'attribute' && attrName(a).toLowerCase() === 'route') return firstStringLiteral(a)
    }
  }
  return undefined
}

export function aspnetRoutesFromSource(content: string, root: Parser.SyntaxNode): ExtractedRoute[] {
  const out: ExtractedRoute[] = []

  // 1) Attribute controllers.
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'class_declaration') {
      const className = node.childForFieldName('name')?.text ?? ''
      const controller = className.replace(/Controller$/, '')
      const classPrefix = classLevelRoute(node)
      for (const m of node.childForFieldName('body')?.namedChildren ?? []) {
        if (m.type !== 'method_declaration') continue
        let verb: string | undefined
        let leaf: string | undefined
        let skip = false
        for (const al of m.namedChildren) {
          if (al.type !== 'attribute_list') continue
          for (const a of al.namedChildren) {
            if (a.type !== 'attribute') continue
            const name = attrName(a).toLowerCase()
            const isVerb = VERB_ATTR[name] !== undefined
            if (!isVerb && name !== 'route') continue
            if (isVerb) verb = VERB_ATTR[name]
            else if (!verb) verb = 'ALL' // a `[Route]` with no verb attribute serves every method
            // Resolve this attribute's template, when it carries one. An attribute
            // with arguments but no plain string literal is an interpolated or
            // computed template — unresolvable, so the whole route is skipped rather
            // than minting a misleading prefix-only path.
            if (a.text.includes('(')) {
              const s = firstStringLiteral(a)
              if (s === undefined) skip = true
              else leaf = s
            }
          }
        }
        if (!verb || skip) continue
        const composed = joinRoute(classPrefix, leaf)
        if (composed === undefined) continue // convention-only route — unknown, unclaimed
        const tpl = expandTokens(composed, controller, m.childForFieldName('name')?.text ?? '')
        out.push({
          method: verb,
          pathTemplate: canonicalizeTemplate(tpl),
          line: m.startPosition.row + 1,
          framework: 'aspnetcore',
        })
      }
    }
    for (const c of node.namedChildren) visit(c)
  }
  visit(root)

  // 2) Minimal API: `app.MapGet("/x", …)` and siblings.
  const visitMinimal = (node: Parser.SyntaxNode): void => {
    if (node.type === 'invocation_expression') {
      const fn = node.childForFieldName('function')
      if (fn?.type === 'member_access_expression') {
        const verb = MAP_VERB[fn.childForFieldName('name')?.text ?? '']
        const firstArg = node.childForFieldName('arguments')?.namedChildren[0]
        const literal = firstArg ? firstStringLiteral(firstArg) : undefined
        if (verb && literal !== undefined && literal.startsWith('/')) {
          out.push({
            method: verb,
            pathTemplate: canonicalizeTemplate(literal),
            line: node.startPosition.row + 1,
            framework: 'aspnetcore',
          })
        }
      }
    }
    for (const c of node.namedChildren) visitMinimal(c)
  }
  visitMinimal(root)

  return out
}

/** Mint ASP.NET Core RouteNodes for every C# service. */
export async function addCsharpRoutes(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const grammar = SYMBOL_GRAMMAR_BY_EXT['.cs']
  if (!grammar) return { nodesAdded: 0, edgesAdded: 0 }
  const parser = new Parser()
  parser.setLanguage(grammar)
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    if (service.node.language !== 'csharp') continue
    const files = await loadSourceFiles(service.dir, service.excludeDirs)
    for (const file of files) {
      if (path.extname(file.path) !== '.cs' || isTestPath(file.path)) continue
      if (!ASPNET_MARKER.test(file.content)) continue
      let routes: ExtractedRoute[]
      try {
        routes = aspnetRoutesFromSource(file.content, parseSource(parser, file.content).rootNode)
      } catch (err) {
        recordExtractionError('csharp route extraction', file.path, err)
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
