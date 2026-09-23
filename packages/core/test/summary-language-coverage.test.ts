import { describe, it, expect, beforeAll } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import { EdgeType, NodeType, Provenance } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { renderValueForwardSummary } from '../src/summary.js'
import { setColorEnabled } from '../src/style.js'

// Force color off so the ✓ / — glyphs render as plain text, byte-stable to
// assert against (the same output a piped / NO_COLOR terminal gets).
beforeAll(() => setColorEnabled(false))

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}

function addService(g: NeatGraph, name: string, language: string): void {
  g.addNode(`service:${name}`, {
    id: `service:${name}`,
    type: NodeType.ServiceNode,
    name,
    language,
  } as GraphNode)
}

function addFile(g: NeatGraph, service: string, path: string): string {
  const id = `file:${service}:${path}`
  g.addNode(id, { id, type: NodeType.FileNode, service, path } as GraphNode)
  return id
}

function addSymbol(g: NeatGraph, service: string, relPath: string, name: string): void {
  const id = `symbol:${service}:${relPath}#${name}`
  g.addNode(id, {
    id,
    type: NodeType.SymbolNode,
    kind: 'function',
    qualname: name,
    span: { startLine: 1, endLine: 2 },
    service,
    relPath,
  } as GraphNode)
}

function addRoute(g: NeatGraph, service: string, method: string, tmpl: string): string {
  const id = `route:${service}:${method} ${tmpl}`
  g.addNode(id, {
    id,
    type: NodeType.RouteNode,
    name: `${method} ${tmpl}`,
    service,
    method,
    pathTemplate: tmpl,
    path: 'src/routes.ts',
  } as GraphNode)
  return id
}

function addTable(g: NeatGraph, name: string): string {
  const id = `infra:sql-table:${name}`
  g.addNode(id, {
    id,
    type: NodeType.InfraNode,
    name,
    provider: 'self',
    kind: 'sql-table',
  } as GraphNode)
  return id
}

function extractedCall(g: NeatGraph, from: string, to: string): void {
  const id = `${EdgeType.CALLS}:${Provenance.EXTRACTED}:${from}->${to}`
  g.addEdgeWithKey(id, from, to, {
    id,
    source: from,
    target: to,
    type: EdgeType.CALLS,
    provenance: Provenance.EXTRACTED,
    evidence: { file: from.replace(/^file:[^:]+:/, '') },
  } as GraphEdge)
}

// A row line for a language, from the rendered summary.
function rowFor(summary: string, lang: string): string {
  const line = summary.split('\n').find((l) => l.trimStart().startsWith(lang + ' '))
  expect(line, `expected a coverage row for ${lang}`).toBeDefined()
  return line as string
}

describe('static coverage by language in the value-forward summary', () => {
  it('marks the cross-service call axis present for JS/TS and absent for Python', () => {
    const g = newGraph()

    // TS service: symbol, route, an outbound client→route CALLS, a data-axis
    // CALLS to a table — every static axis produces output.
    addService(g, 'frontend', 'typescript')
    const tsFile = addFile(g, 'frontend', 'src/client.ts')
    addSymbol(g, 'frontend', 'src/client.ts', 'load')
    addRoute(g, 'frontend', 'GET', '/health')
    const tsTable = addTable(g, 'sessions')
    extractedCall(g, tsFile, tsTable)

    // The Python API this TS client calls: symbol, route, a data-axis CALLS —
    // but no outbound client→route edge, because the client recognizer reads
    // JS/TS only. That is the #1158 gap this block makes legible.
    addService(g, 'api', 'python')
    const pyFile = addFile(g, 'api', 'app/main.py')
    addSymbol(g, 'api', 'app/main.py', 'handler')
    const pyRoute = addRoute(g, 'api', 'POST', '/orders')
    const pyTable = addTable(g, 'orders')
    extractedCall(g, pyFile, pyTable)

    // The TS client's cross-service call lands on the Python route.
    extractedCall(g, tsFile, pyRoute)

    const out = renderValueForwardSummary({ graph: g, divergences: [], verbose: false })

    expect(out).toContain('static coverage by language (this scan):')
    expect(out).toContain('#1158')

    // TS row: cross-service calls present (last column ✓).
    const ts = rowFor(out, 'typescript')
    expect(ts.trimEnd().endsWith('✓')).toBe(true)

    // Python row: symbols/routes/data present, cross-service calls absent
    // (last column —).
    const py = rowFor(out, 'python')
    expect(py).toContain('✓') // it produced symbols/routes/data
    expect(py.trimEnd().endsWith('—')).toBe(true)
  })

  it('omits the block when the scan is pure JS/TS (nothing off-island to state)', () => {
    const g = newGraph()
    addService(g, 'web', 'typescript')
    const f = addFile(g, 'web', 'src/index.ts')
    addSymbol(g, 'web', 'src/index.ts', 'main')
    const t = addTable(g, 'users')
    extractedCall(g, f, t)

    const out = renderValueForwardSummary({ graph: g, divergences: [], verbose: false })
    expect(out).not.toContain('static coverage by language')
  })
})
