import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  type GraphEdge,
  type GraphNode,
  type SymbolKind,
  type SymbolNode,
  extractedEdgeId,
  fileId,
  localDatabaseId,
  observedEdgeId,
  serviceId,
  symbolId,
} from '@neat.is/types'
import { ensureFileNode } from '../src/extract/calls/shared.js'
import { handleSpan, resetParentSpanCache, type IngestContext } from '../src/ingest.js'
import type { ParsedSpan } from '../src/otel.js'
import type { NeatGraph } from '../src/graph.js'

// ADR-158 Phase 1 — the observed→symbol landing. `code.function` and `code.line`
// are already on every CLIENT/PRODUCER span (file-awareness.md §4); ingest now
// lands the OBSERVED edge on the SymbolNode whose definition span contains the
// line, degrading to the file when none does.

const SVC = 'service-a'
const REL = 'src/db/orders.ts'

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}

// Seed a statically-extracted symbol on a file: the SymbolNode plus its owning
// file ──CONTAINS──▶ symbol EXTRACTED edge (test files may mutate the graph).
function seedSymbol(
  g: NeatGraph,
  qualname: string,
  kind: SymbolKind,
  startLine: number,
  endLine: number,
): string {
  const fnode = fileId(SVC, REL)
  const sid = symbolId(SVC, REL, qualname)
  const node: SymbolNode = {
    id: sid,
    type: NodeType.SymbolNode,
    kind,
    qualname,
    span: { startLine, endLine },
    service: SVC,
    relPath: REL,
    discoveredVia: 'static',
  }
  g.addNode(sid, node)
  const cid = extractedEdgeId(fnode, sid, EdgeType.CONTAINS)
  g.addEdgeWithKey(cid, fnode, sid, {
    id: cid,
    source: fnode,
    target: sid,
    type: EdgeType.CONTAINS,
    provenance: Provenance.EXTRACTED,
    confidence: 0.85,
    evidence: { file: REL, line: startLine },
  })
  return sid
}

// An embedded-sqlite query span: synchronous, no peer host, carrying the call
// site's file/line/function — the same shape as the in-process DB tests. The
// OBSERVED CONNECTS_TO edge it mints originates from `observedSource()`, which is
// what symbol grain sharpens from the file to the calling symbol.
function dbSpan(line: number | undefined, fn: string | undefined): ParsedSpan {
  const attrs: Record<string, string | number> = {
    'db.system': 'sqlite',
    'db.name': 'app.db',
    'code.filepath': '/var/task/src/db/orders.ts',
  }
  if (line !== undefined) attrs['code.lineno'] = line
  if (fn !== undefined) attrs['code.function'] = fn
  return {
    service: SVC,
    traceId: 'trace-sym',
    spanId: 'span-db',
    name: 'SELECT orders',
    kind: 3,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    durationNanos: 0n,
    env: 'unknown',
    attributes: attrs,
    dbSystem: 'sqlite',
    dbName: 'app.db',
    statusCode: 0,
  }
}

describe('observed → symbol landing (ADR-158)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    resetParentSpanCache()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-symgrain-'))
    ctx = { graph: newGraph(), errorsPath: path.join(tmpDir, 'errors.ndjson') }
    // The extractor already discovered the service, parsed this repo file, and
    // minted its symbols.
    ctx.graph.addNode(serviceId(SVC), {
      id: serviceId(SVC),
      type: NodeType.ServiceNode,
      name: SVC,
      language: 'typescript',
    })
    ensureFileNode(ctx.graph, SVC, serviceId(SVC), REL)
    seedSymbol(ctx.graph, 'createOrder', 'function', 5, 8)
    seedSymbol(ctx.graph, 'OrderService', 'class', 15, 30)
    seedSymbol(ctx.graph, 'OrderService.create', 'method', 22, 25)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    resetParentSpanCache()
  })

  const dbId = localDatabaseId(SVC, 'app.db')

  it('lands the OBSERVED edge on the symbol whose span contains code.line (innermost, name-validated)', async () => {
    // Line 24 is inside both OrderService (15–30) and OrderService.create (22–25);
    // the innermost method wins, and code.function `create` matches its terminal.
    await handleSpan(ctx, dbSpan(24, 'create'))

    const symId = symbolId(SVC, REL, 'OrderService.create')
    const edgeId = observedEdgeId(symId, dbId, EdgeType.CONNECTS_TO)
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.source).toBe(symId)
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    // Symbol grain is call-site-captured, not the coarse service fallback.
    expect(edge.grain).toBe('file')
    // Evidence still names the real file:line.
    expect(edge.evidence?.file).toBe(REL)
    expect(edge.evidence?.line).toBe(24)

    // The edge does NOT originate from the bare file node — grain was sharpened.
    const fileEdgeId = observedEdgeId(fileId(SVC, REL), dbId, EdgeType.CONNECTS_TO)
    expect(ctx.graph.hasEdge(fileEdgeId)).toBe(false)
  })

  it('degrades to the file node when the line is inside no symbol span and the span carries no function', async () => {
    await handleSpan(ctx, dbSpan(100, undefined))

    const fileEdgeId = observedEdgeId(fileId(SVC, REL), dbId, EdgeType.CONNECTS_TO)
    expect(ctx.graph.hasEdge(fileEdgeId)).toBe(true)
    const edge = ctx.graph.getEdgeAttributes(fileEdgeId) as GraphEdge
    expect(edge.source).toBe(fileId(SVC, REL))
  })

  it('mints an `otel` symbol when a named runtime call lands where static produced none (missing-extracted at symbol grain)', async () => {
    // Line 100 is inside no static symbol, but the span names the function — a
    // dynamically-wired or extractor-gap symbol. It is minted discoveredVia otel.
    await handleSpan(ctx, dbSpan(100, 'dynamicHandler'))

    const symId = symbolId(SVC, REL, 'dynamicHandler')
    expect(ctx.graph.hasNode(symId)).toBe(true)
    const node = ctx.graph.getNodeAttributes(symId) as SymbolNode
    expect(node.type).toBe(NodeType.SymbolNode)
    expect(node.discoveredVia).toBe('otel')
    expect(node.qualname).toBe('dynamicHandler')

    // The observed edge originates from the otel symbol, and the file owns it
    // through an OBSERVED CONTAINS edge.
    const edgeId = observedEdgeId(symId, dbId, EdgeType.CONNECTS_TO)
    expect(ctx.graph.hasEdge(edgeId)).toBe(true)
    const containsId = observedEdgeId(fileId(SVC, REL), symId, EdgeType.CONTAINS)
    expect(ctx.graph.hasEdge(containsId)).toBe(true)
    expect((ctx.graph.getEdgeAttributes(containsId) as GraphEdge).provenance).toBe(
      Provenance.OBSERVED,
    )
  })

  it('does not mint an otel symbol on a file that was never symbol-extracted — it degrades to the file', async () => {
    // A second file with a FileNode but NO symbols. A named span in it must not
    // fabricate a symbol inventory; it degrades to the file node honestly.
    const otherRel = 'src/db/no-symbols.ts'
    ensureFileNode(ctx.graph, SVC, serviceId(SVC), otherRel)
    await handleSpan(ctx, {
      ...dbSpan(10, 'someFn'),
      attributes: {
        'db.system': 'sqlite',
        'db.name': 'app.db',
        'code.filepath': '/var/task/src/db/no-symbols.ts',
        'code.lineno': 10,
        'code.function': 'someFn',
      },
    })

    expect(ctx.graph.hasNode(symbolId(SVC, otherRel, 'someFn'))).toBe(false)
    const fileEdgeId = observedEdgeId(fileId(SVC, otherRel), dbId, EdgeType.CONNECTS_TO)
    expect(ctx.graph.hasEdge(fileEdgeId)).toBe(true)
  })
})
