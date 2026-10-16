import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance, extractedEdgeId, symbolId } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'symbol-edges-go')

// #1409 — the Go rung of ADR-158 §3 symbol edges (the Go slice of #1158). A single
// go.mod module whose edges.go makes same-file bare-function calls, a method
// selector call, a builtin call, a recursive self-call, and a cross-file
// same-package call. The producer mints a symbol→symbol CALLS only for a bare
// identifier resolving to exactly one same-file top-level function — and nothing else.
describe('Go static symbol edges (#1409 — the Go rung of ADR-158 §3)', () => {
  beforeEach(() => resetGraph())

  const SVC = 'edges-go'
  const REL = 'edges.go'
  const sym = (q: string) => symbolId(SVC, REL, q)

  const goCalls = (graph: ReturnType<typeof getGraph>): string[] => {
    const out: string[] = []
    graph.forEachEdge((_id, attrs) => {
      const ed = attrs as GraphEdge
      if (ed.type === EdgeType.CALLS && ed.source.startsWith('symbol:')) {
        out.push(`${ed.source} -> ${ed.target}`)
      }
    })
    return out
  }

  it('mints same-file symbol→symbol CALLS for bare-identifier function calls', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // build() calls helper() and tally() (forward-declared, same file).
    const toHelper = extractedEdgeId(sym('build'), sym('helper'), EdgeType.CALLS)
    expect(graph.hasEdge(toHelper)).toBe(true)
    const e = graph.getEdgeAttributes(toHelper) as GraphEdge
    expect(e.source).toBe(sym('build'))
    expect(e.target).toBe(sym('helper'))
    expect(e.provenance).toBe(Provenance.EXTRACTED)
    expect(e.evidence?.file).toBe(REL)
    expect(e.evidence?.line).toBeGreaterThan(0)
    expect(e.evidence?.snippet).toContain('helper')

    expect(graph.hasEdge(extractedEdgeId(sym('build'), sym('tally'), EdgeType.CALLS))).toBe(true)
  })

  it('never guesses: method selector, builtin, recursion, and cross-file calls mint nothing', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // The complete Go symbol→symbol CALLS set for this fixture is exactly the two
    // confident same-file edges. Everything else is left to observed / a later rung.
    expect(new Set(goCalls(graph))).toEqual(
      new Set([`${sym('build')} -> ${sym('helper')}`, `${sym('build')} -> ${sym('tally')}`]),
    )

    // No self-loop from the recursive loop().
    expect(graph.hasEdge(extractedEdgeId(sym('loop'), sym('loop'), EdgeType.CALLS))).toBe(false)
    // describe()'s s.Render() (selector) mints nothing — Render is a method, never a bare callee.
    expect(
      graph.hasEdge(extractedEdgeId(sym('describe'), sym('Server.Render'), EdgeType.CALLS)),
    ).toBe(false)
    // build()'s cross-file extra() (same package, another file) is a deferred rung.
    expect(
      graph.hasEdge(extractedEdgeId(sym('build'), symbolId(SVC, 'more.go', 'extra'), EdgeType.CALLS)),
    ).toBe(false)
  })

  it('is idempotent — a second extract pass adds no Go CALLS', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)
    const first = goCalls(graph).length
    await extractFromDirectory(graph, FIXTURES)
    expect(goCalls(graph).length).toBe(first)
  })
})
