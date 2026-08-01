import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance, extractedEdgeId, symbolId } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'symbol-edges')

// ADR-158 Phase 2 — static symbol *edges*, the confident ones only. A two-file
// TypeScript fixture: base.ts defines a base class, an abstract-class contract, a
// plain interface, and a function; widget.ts extends the base, implements the
// contract + the interface, and makes same-file / imported / method / external
// calls. The producer must resolve heritage + calls cross-file when — and only
// when — the target is exactly one known SymbolNode, and emit nothing otherwise.
describe('static symbol edges (ADR-158 Phase 2)', () => {
  beforeEach(() => resetGraph())

  const SVC = 'edge-svc'
  const base = (q: string) => symbolId(SVC, 'src/base.ts', q)
  const widget = (q: string) => symbolId(SVC, 'src/widget.ts', q)

  it('mints INHERITS + IMPLEMENTS onto imported symbols, resolved cross-file', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // class Widget extends BaseWidget (imported) → INHERITS, symbol→symbol.
    const inheritsId = extractedEdgeId(widget('Widget'), base('BaseWidget'), EdgeType.INHERITS)
    expect(graph.hasEdge(inheritsId)).toBe(true)
    const inherits = graph.getEdgeAttributes(inheritsId) as GraphEdge
    expect(inherits.source).toBe(widget('Widget'))
    expect(inherits.target).toBe(base('BaseWidget'))
    expect(inherits.provenance).toBe(Provenance.EXTRACTED)
    expect(inherits.evidence?.file).toBe('src/widget.ts')
    expect(inherits.evidence?.line).toBeGreaterThan(0)
    expect(inherits.evidence?.snippet).toContain('BaseWidget')

    // class Widget implements Comparable (imported abstract class) → IMPLEMENTS.
    const implementsId = extractedEdgeId(widget('Widget'), base('Comparable'), EdgeType.IMPLEMENTS)
    expect(graph.hasEdge(implementsId)).toBe(true)
    const impl = graph.getEdgeAttributes(implementsId) as GraphEdge
    expect(impl.target).toBe(base('Comparable'))
    expect(impl.provenance).toBe(Provenance.EXTRACTED)
    expect(impl.evidence?.snippet).toContain('Comparable')
  })

  it('emits NO IMPLEMENTS edge for a plain interface (interfaces are not SymbolNodes)', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // Serializable is an interface — never extracted as a SymbolNode (ADR-158 §2),
    // so no node exists and no IMPLEMENTS edge is guessed onto it.
    expect(graph.hasNode(base('Serializable'))).toBe(false)

    // Widget has exactly one IMPLEMENTS out-edge (Comparable); the Serializable
    // clause produced nothing.
    const implTargets: string[] = []
    graph.forEachOutboundEdge(widget('Widget'), (_id, attrs) => {
      if ((attrs as GraphEdge).type === EdgeType.IMPLEMENTS) implTargets.push((attrs as GraphEdge).target)
    })
    expect(implTargets).toEqual([base('Comparable')])
  })

  it('mints symbol→symbol CALLS for a same-file and an imported function', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // buildWidget() calls helper() (same-file) and formatLabel() (imported).
    const sameFile = extractedEdgeId(widget('buildWidget'), widget('helper'), EdgeType.CALLS)
    expect(graph.hasEdge(sameFile)).toBe(true)
    const e1 = graph.getEdgeAttributes(sameFile) as GraphEdge
    expect(e1.provenance).toBe(Provenance.EXTRACTED)
    expect(e1.evidence?.file).toBe('src/widget.ts')
    expect(e1.evidence?.snippet).toContain('helper')

    const imported = extractedEdgeId(widget('buildWidget'), base('formatLabel'), EdgeType.CALLS)
    expect(graph.hasEdge(imported)).toBe(true)
    expect((graph.getEdgeAttributes(imported) as GraphEdge).target).toBe(base('formatLabel'))
  })

  it('never guesses: a method call on a typed receiver and an unresolvable import emit no edge', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // The full symbol→symbol edge set — heritage + calls — is exactly the four
    // confident edges. render()'s `this.decorate(...)` (method dispatch) and
    // `renderExternal(...)` (unresolvable external import) contribute nothing,
    // and the interface implement contributes nothing.
    const symbolEdges: string[] = []
    graph.forEachEdge((_id, attrs) => {
      const e = attrs as GraphEdge
      if (
        (e.type === EdgeType.CALLS ||
          e.type === EdgeType.INHERITS ||
          e.type === EdgeType.IMPLEMENTS) &&
        e.source.startsWith('symbol:')
      ) {
        symbolEdges.push(`${e.type} ${e.source} -> ${e.target}`)
      }
    })

    expect(new Set(symbolEdges)).toEqual(
      new Set([
        `${EdgeType.INHERITS} ${widget('Widget')} -> ${base('BaseWidget')}`,
        `${EdgeType.IMPLEMENTS} ${widget('Widget')} -> ${base('Comparable')}`,
        `${EdgeType.CALLS} ${widget('buildWidget')} -> ${widget('helper')}`,
        `${EdgeType.CALLS} ${widget('buildWidget')} -> ${base('formatLabel')}`,
      ]),
    )

    // No self-loops, and no target is a language keyword.
    const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'this', 'super'])
    for (const line of symbolEdges) {
      const [, source, , target] = line.split(' ')
      expect(source).not.toBe(target)
      const targetQual = target!.split('#')[1]
      expect(keywords.has(targetQual!)).toBe(false)
    }
  })
})
