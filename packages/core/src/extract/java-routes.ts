import path from 'node:path'
import Parser from 'tree-sitter'
import Java from 'tree-sitter-java'
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

// Spring MVC route extraction. A Java service's HTTP surface is declared in
// annotations: a controller class may carry a `@RequestMapping("/prefix")`, and
// each handler method a `@GetMapping` / `@PostMapping` / `@PutMapping` /
// `@DeleteMapping` / `@PatchMapping`, or a `@RequestMapping(method = …)`. Each
// (method, path) pair becomes a RouteNode owned by its service through
// `service ──CONTAINS──▶ route`, the same shape addRoutes mints for every other
// router (ADR-119), so a Spring server span's `http.route` fuses onto it.
//
// The gate is the source, not the manifest. A Spring service usually inherits
// `spring-boot-starter-web` from a parent POM (train-ticket's 41 services all
// do), and java.ts reads each module's own POM, so the dependency isn't there to
// gate on. A file is read when it imports `org.springframework.web.bind.annotation`
// (or names an annotation fully qualified), the per-file self-gate Sinatra and
// Slim use (ADR-206).
//
// Only classes Spring treats as handlers are read: a `@RestController` /
// `@Controller`, or a class carrying `@RequestMapping` itself. A `@FeignClient`
// interface declares the same annotations for the *client* side and is never a
// route. A path that isn't a literal, or a concatenation of literals and same-file
// `static final String` constants, stays unclaimed rather than guessed.

const PARSE_CHUNK = 16384
const SPRING_WEB = 'org.springframework.web.bind.annotation'

const VERB_ANNOTATIONS: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
}
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE'])

function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) =>
    index >= source.length ? '' : source.slice(index, index + PARSE_CHUNK),
  )
}

export function makeJavaParser(): Parser {
  const p = new Parser()
  p.setLanguage(Java)
  return p
}

// The annotation's simple name and whether it was written fully qualified under
// Spring's web package.
function annotationName(node: Parser.SyntaxNode): { name: string; qualified: boolean } | null {
  const n = node.childForFieldName('name')
  if (!n) return null
  const text = n.text
  const dot = text.lastIndexOf('.')
  return dot === -1
    ? { name: text, qualified: false }
    : { name: text.slice(dot + 1), qualified: text.slice(0, dot) === SPRING_WEB }
}

function annotationsOf(decl: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const mods = decl.namedChildren.find((c) => c.type === 'modifiers')
  if (!mods) return []
  return mods.namedChildren.filter((c) => c.type === 'annotation' || c.type === 'marker_annotation')
}

function javaStringLiteral(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'string_literal') return null
  // A plain literal's fragments; an escape sequence makes it not worth guessing.
  let out = ''
  for (const c of node.namedChildren) {
    if (c.type === 'string_fragment') out += c.text
    else return null
  }
  return out
}

// `static final String NAME = "literal"` fields anywhere in the file.
function stringConstants(root: Parser.SyntaxNode): Map<string, string> {
  const out = new Map<string, string>()
  const visit = (n: Parser.SyntaxNode): void => {
    if (n.type === 'field_declaration') {
      const mods = n.namedChildren.find((c) => c.type === 'modifiers')?.text ?? ''
      if (/\bstatic\b/.test(mods) && /\bfinal\b/.test(mods)) {
        for (const d of n.namedChildren) {
          if (d.type !== 'variable_declarator') continue
          const name = d.childForFieldName('name')?.text
          const value = d.childForFieldName('value')
          const lit = value ? constantString(value, out) : null
          if (name && lit !== null) out.set(name, lit)
        }
      }
    }
    for (const c of n.namedChildren) visit(c)
  }
  visit(root)
  return out
}

// A string built only from literals and known constants; null otherwise.
function constantString(node: Parser.SyntaxNode, consts: Map<string, string>): string | null {
  if (node.type === 'string_literal') return javaStringLiteral(node)
  if (node.type === 'identifier') return consts.get(node.text) ?? null
  if (node.type === 'parenthesized_expression' && node.namedChildren[0]) {
    return constantString(node.namedChildren[0], consts)
  }
  if (node.type === 'binary_expression' && node.childForFieldName('operator')?.text === '+') {
    const l = node.childForFieldName('left')
    const r = node.childForFieldName('right')
    const ls = l ? constantString(l, consts) : null
    const rs = r ? constantString(r, consts) : null
    return ls !== null && rs !== null ? ls + rs : null
  }
  return null
}

// The value nodes for `key` (or the lone positional value, which Spring binds to
// `value`), unwrapping an `{a, b}` array.
function annotationValues(ann: Parser.SyntaxNode, keys: string[]): Parser.SyntaxNode[] | null {
  const args = ann.childForFieldName('arguments')
  if (!args) return null
  let value: Parser.SyntaxNode | null = null
  for (const c of args.namedChildren) {
    if (c.type === 'element_value_pair') {
      if (keys.includes(c.childForFieldName('key')?.text ?? '')) value = c.childForFieldName('value')
    } else if (keys.includes('value')) {
      value = c
    }
  }
  if (!value) return null
  return value.type === 'element_value_array_initializer' ? value.namedChildren : [value]
}

// The paths an annotation declares: [''] when it names none (the handler sits at
// the prefix), null when one isn't a resolvable constant (skip, don't guess).
function annotationPaths(ann: Parser.SyntaxNode, consts: Map<string, string>): string[] | null {
  const values = annotationValues(ann, ['value', 'path'])
  if (!values || values.length === 0) return ['']
  const out: string[] = []
  for (const v of values) {
    const s = constantString(v, consts)
    if (s === null) return null
    out.push(s)
  }
  return out
}

// `method = RequestMethod.GET` / `{GET, POST}`; ['ALL'] when none is named.
function requestMappingMethods(ann: Parser.SyntaxNode): string[] | null {
  const values = annotationValues(ann, ['method'])
  if (!values || values.length === 0) return ['ALL']
  const out: string[] = []
  for (const v of values) {
    const name = (v.type === 'field_access' ? v.childForFieldName('field')?.text : v.text) ?? ''
    if (!HTTP_METHODS.has(name)) return null
    out.push(name)
  }
  return out
}

function joinPath(prefix: string, leaf: string): string {
  if (!prefix) return canonicalizeTemplate(leaf || '/')
  if (!leaf) return canonicalizeTemplate(prefix)
  return canonicalizeTemplate(prefix.replace(/\/+$/, '') + '/' + leaf.replace(/^\/+/, ''))
}

function importsSpringWeb(root: Parser.SyntaxNode): boolean {
  return root.namedChildren.some(
    (c) => c.type === 'import_declaration' && c.text.includes(SPRING_WEB),
  )
}

/** Spring MVC routes declared in one Java source file. */
export function springRoutesFromSource(source: string, parser: Parser): ExtractedRoute[] {
  const root = parseSource(parser, source).rootNode
  const imported = importsSpringWeb(root)
  const consts = stringConstants(root)
  const out: ExtractedRoute[] = []
  const isSpring = (a: { qualified: boolean }): boolean => imported || a.qualified

  const visitClass = (cls: Parser.SyntaxNode): void => {
    const anns = annotationsOf(cls)
    let isHandler = false
    let prefixes: string[] | null = ['']
    for (const a of anns) {
      const n = annotationName(a)
      if (!n) continue
      if (n.name === 'RestController' || n.name === 'Controller') isHandler = true
      if (n.name === 'RequestMapping' && isSpring(n)) {
        isHandler = true
        prefixes = annotationPaths(a, consts)
      }
    }
    const body = cls.childForFieldName('body')
    if (isHandler && prefixes && body) {
      for (const m of body.namedChildren) {
        if (m.type !== 'method_declaration') continue
        for (const a of annotationsOf(m)) {
          const n = annotationName(a)
          if (!n || !isSpring(n)) continue
          const verb = VERB_ANNOTATIONS[n.name]
          const methods = verb ? [verb] : n.name === 'RequestMapping' ? requestMappingMethods(a) : null
          if (!methods) continue
          const leaves = annotationPaths(a, consts)
          if (!leaves) continue
          for (const prefix of prefixes) {
            for (const leaf of leaves) {
              for (const method of methods) {
                out.push({
                  method,
                  pathTemplate: joinPath(prefix, leaf),
                  line: a.startPosition.row + 1,
                  framework: 'spring',
                })
              }
            }
          }
        }
      }
    }
    // Nested classes declare their own mappings, with their own prefix.
    if (body) for (const c of body.namedChildren) if (c.type === 'class_declaration') visitClass(c)
  }

  for (const c of root.namedChildren) if (c.type === 'class_declaration') visitClass(c)
  return out
}

/** Mint Spring MVC RouteNodes for every Java service. */
export async function addJavaRoutes(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const parser = makeJavaParser()
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    if (service.node.language !== 'java') continue
    const files = await loadSourceFiles(service.dir, service.excludeDirs)
    for (const file of files) {
      if (path.extname(file.path) !== '.java' || isTestPath(file.path)) continue
      // Cheap pre-check before parsing: a file with no Spring web reference
      // can't declare a route.
      if (!file.content.includes(SPRING_WEB)) continue
      let routes: ExtractedRoute[]
      try {
        routes = springRoutesFromSource(file.content, parser)
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
