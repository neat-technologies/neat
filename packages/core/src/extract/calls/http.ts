import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import Python from 'tree-sitter-python'
import type { GraphEdge } from '@neat.is/types'
import {
  EdgeType,
  Provenance,
  confidenceForExtracted,
  passesExtractedFloor,
} from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import {
  isTestPath,
  makeEdgeId,
  urlMatchesHost,
  type DiscoveredService,
} from '../shared.js'
import { recordExtractionError, noteExtractedDropped } from '../errors.js'
import {
  buildServiceHostIndex,
  ensureFileNode,
  loadSourceFiles,
  snippet,
  toPosix,
} from './shared.js'

// JS uses `string_fragment` for the textual interior of a template/string;
// Python uses `string_content` inside a `string` node. Either way we want the
// raw textual content (no quotes), so we accept both.
const STRING_LITERAL_NODE_TYPES = new Set(['string_fragment', 'string_content'])

// ADR-065 #3 — JSX external-link exclusion. Tags whose URL-attr strings are
// user-clickable hyperlinks, not service-to-service calls.
const JSX_EXTERNAL_LINK_TAGS = new Set(['a', 'Link', 'NavLink', 'ExternalLink', 'Anchor'])

// Walk upward from a string-literal node to detect whether it sits inside a
// JSX attribute on an external-link element. Returns true if the literal
// should be filtered.
function isInsideJsxExternalLink(node: Parser.SyntaxNode): boolean {
  let cursor: Parser.SyntaxNode | null = node.parent
  // Step out of the string wrapper if needed (parent is `string` /
  // `template_string`).
  while (cursor) {
    if (cursor.type === 'jsx_attribute') {
      // The element that owns this attribute. jsx_attribute lives inside
      // jsx_opening_element / jsx_self_closing_element.
      let owner: Parser.SyntaxNode | null = cursor.parent
      while (owner && owner.type !== 'jsx_opening_element' && owner.type !== 'jsx_self_closing_element') {
        owner = owner.parent
      }
      if (!owner) return false
      // First named child of an opening/self-closing element is the tag name
      // (`identifier` or `member_expression`).
      const tagNode = owner.namedChild(0)
      const tagName = tagNode?.text ?? ''
      // For `<Foo.Bar>` we just want the rightmost ident; pick after the
      // last dot.
      const right = tagName.includes('.') ? tagName.split('.').pop()! : tagName
      return JSX_EXTERNAL_LINK_TAGS.has(right)
    }
    cursor = cursor.parent
  }
  return false
}

// Collect (literal text, ast-node) pairs so the JSX-context check has the
// node available. Comment tokens have no string_fragment / string_content
// children in tree-sitter — JSDoc text lives inside `comment` nodes — so
// comment-body exclusion comes for free with this AST walk (ADR-065 #2).
function collectStringLiterals(
  node: Parser.SyntaxNode,
  out: { text: string; node: Parser.SyntaxNode }[],
): void {
  if (STRING_LITERAL_NODE_TYPES.has(node.type)) out.push({ text: node.text, node })
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child) collectStringLiterals(child, out)
  }
}

// A matched outbound call: the host the URL literal names and the 1-indexed
// line it sits on. File-first extraction (file-awareness.md §1) originates a
// CALLS edge from the file the call site lives in, so the position travels with
// the host rather than being recovered after the fact.
export interface HttpCallSite {
  host: string
  line: number
}

// tree-sitter's node binding copies a string handed to `parser.parse` into a
// fixed scratch buffer of ~32K code units and throws a bare "Invalid argument"
// once the source is larger — it never names the size as the cause. NEAT's own
// `cli.ts`, `ingest.ts`, and `installers/javascript.ts` all clear 40K, so the
// http-call extractor was quietly skipping the three most interesting files in
// the repo while dogfooding NEAT-on-NEAT. The callback form sidesteps the
// buffer entirely: tree-sitter pulls the text in chunks we keep well under the
// limit, so a file of any length parses. Chunking is by `.length` (UTF-16 code
// units), which is exactly what the buffer counts.
const PARSE_CHUNK = 16384

function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) =>
    index >= source.length ? '' : source.slice(index, index + PARSE_CHUNK),
  )
}

export function callsFromSource(
  source: string,
  parser: Parser,
  knownHosts: Set<string>,
): HttpCallSite[] {
  const tree = parseSource(parser, source)
  const literals: { text: string; node: Parser.SyntaxNode }[] = []
  collectStringLiterals(tree.rootNode, literals)
  const out: HttpCallSite[] = []
  for (const lit of literals) {
    // ADR-065 #3 — JSX external-link exclusion. URL strings on <a>, <Link>,
    // <NavLink>, <ExternalLink>, <Anchor> are user-clickable hyperlinks, not
    // service calls.
    if (isInsideJsxExternalLink(lit.node)) continue
    for (const host of knownHosts) {
      // ADR-065 #5 — exact hostname match (not substring containment).
      // `medusa.cloud` no longer matches `@medusajs/medusa`.
      if (urlMatchesHost(lit.text, host)) {
        out.push({ host, line: lit.node.startPosition.row + 1 })
      }
    }
  }
  return out
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

// HTTP CALLS via URL hostname match. Parser is picked per file extension:
// .py uses tree-sitter-python; everything else uses tree-sitter-javascript.
//
// File-first (file-awareness.md §1): each matched call site originates a
// `file:<svc>:<relPath> ──CALLS──▶ target` edge plus the owning service's
// CONTAINS edge, rather than collapsing every call in a service to one
// service-level edge.
//
// File-node existence is independent of edge-target precision (file-awareness.md
// §1, ADR-089 amendment). A matched call site is a parsed fact — the file and
// its `service ──CONTAINS──▶ file` edge are certain regardless of how confident
// we are about *what* it calls. So the FileNode + CONTAINS materialize for every
// matched site; only the file→target CALLS edge is subject to the precision
// floor. A scheme-qualified URL literal to a registered service grades at the
// floor (url-literal-service-target, 0.7) so the declared HTTP dependency enters
// the graph; if the floor is raised past it for diagnostics the file and its
// call site still surface, without claiming the resolved target.
export async function addHttpCallEdges(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const jsParser = makeJsParser()
  const pyParser = makePyParser()

  // Host → owning ServiceNode id (ADR-065 #5), shared with the route-matching
  // producer so both resolve a URL's host to a service the same way.
  const { knownHosts, hostToNodeId } = buildServiceHostIndex(services)

  let nodesAdded = 0
  let edgesAdded = 0
  for (const service of services) {
    const files = await loadSourceFiles(service.dir)
    // File grain: one file→target CALLS per (file, target) pair, even when a
    // file names the same host on several lines (function-level is deferred).
    const seen = new Set<string>()
    for (const file of files) {
      // ADR-065 #1 — test-scope exclusion.
      if (isTestPath(file.path)) continue
      const parser = path.extname(file.path) === '.py' ? pyParser : jsParser
      let sites: HttpCallSite[]
      try {
        sites = callsFromSource(file.content, parser, knownHosts)
      } catch (err) {
        recordExtractionError('http call extraction', file.path, err)
        continue
      }
      if (sites.length === 0) continue
      const relFile = toPosix(path.relative(service.dir, file.path))
      for (const site of sites) {
        const targetId = hostToNodeId.get(site.host)
        if (!targetId || targetId === service.node.id) continue
        const dedupKey = `${relFile}|${targetId}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)
        // A scheme-qualified URL literal that resolves to a registered service
        // is a declared HTTP dependency (static-extraction contract §5). It
        // grades at the precision floor rather than below it, so the EXTRACTED
        // CALLS edge enters the graph and missing-observed can flag a declared-
        // but-never-driven upstream (issue #592). Still below structural /
        // verified-call-site: no call expression wraps the literal.
        const confidence = confidenceForExtracted('url-literal-service-target')
        const ev = {
          file: relFile,
          line: site.line,
          snippet: snippet(file.content, site.line),
        }
        // The matched call site is a parsed fact: materialize the FileNode and
        // its `service ──CONTAINS──▶ file` edge regardless of target precision
        // (file-awareness.md §1, ADR-089 amendment). The file surfaces even
        // when the resolved target sits below the floor.
        const { fileNodeId, nodesAdded: n, edgesAdded: e } = ensureFileNode(
          graph,
          service.pkg.name,
          service.node.id,
          relFile,
        )
        nodesAdded += n
        edgesAdded += e
        // The file→target CALLS edge alone is subject to the precision floor.
        // A sub-floor target is recorded as a drop (banner accounting) and not
        // claimed as a resolved edge — the file and its call site still stand.
        if (!passesExtractedFloor(confidence)) {
          noteExtractedDropped({
            source: fileNodeId,
            target: targetId,
            type: EdgeType.CALLS,
            confidence,
            confidenceKind: 'url-literal-service-target',
            evidence: ev,
          })
          continue
        }
        const edgeId = makeEdgeId(fileNodeId, targetId, EdgeType.CALLS)
        if (!graph.hasEdge(edgeId)) {
          const edge: GraphEdge = {
            id: edgeId,
            source: fileNodeId,
            target: targetId,
            type: EdgeType.CALLS,
            provenance: Provenance.EXTRACTED,
            confidence,
            evidence: ev,
          }
          graph.addEdgeWithKey(edgeId, fileNodeId, targetId, edge)
          edgesAdded++
        }
      }
    }
  }
  return { nodesAdded, edgesAdded }
}
