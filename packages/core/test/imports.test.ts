import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'imports')

describe('import graph extraction (ADR-092, file-awareness.md §10)', () => {
  beforeEach(() => resetGraph())

  it('emits an IMPORTS edge for a relative TS import, with evidence', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const edgeId =
      'IMPORTS:file:fixture-imports-ts-service:index.ts->file:fixture-imports-ts-service:mongo.ts'
    expect(graph.hasEdge(edgeId)).toBe(true)

    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe('EXTRACTED')
    expect(edge.evidence?.file).toBe('index.ts')
    expect(edge.evidence?.line).toBeGreaterThan(0)
    expect(edge.evidence?.snippet).toContain('./mongo')
  })

  it('does not emit an edge for a node_modules import', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    expect(
      graph.hasEdge(
        'IMPORTS:file:fixture-imports-ts-service:index.ts->file:fixture-imports-ts-service:express.ts',
      ),
    ).toBe(false)
    // express never resolves to an intra-service file, so no FileNode for it.
    expect(graph.hasNode('file:fixture-imports-ts-service:express.ts')).toBe(false)

    const ts = graph.getNodeAttributes(
      'file:fixture-imports-ts-service:index.ts',
    ) as Record<string, unknown>
    expect(ts).toBeDefined()
  })

  it('does not emit an edge or raise an error for an unresolvable TS path alias', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, FIXTURES)

    expect(graph.hasNode('file:fixture-imports-alias-service:src/index.ts')).toBe(true)
    // @db/mongo maps to src/db/mongo.ts, which doesn't exist on disk.
    const edges = graph.edges().filter((id) => id.startsWith('IMPORTS:file:fixture-imports-alias-service:'))
    expect(edges).toHaveLength(0)
    expect(result.extractionErrors).toBe(0)
  })

  it('emits an IMPORTS edge for a Python relative import', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const edgeId =
      'IMPORTS:file:fixture-imports-py-service:app/main.py->file:fixture-imports-py-service:app/utils.py'
    expect(graph.hasEdge(edgeId)).toBe(true)

    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe('EXTRACTED')
    expect(edge.evidence?.file).toBe('app/main.py')
    expect(edge.evidence?.snippet).toContain('format_total')
  })

  it('is idempotent across repeated passes', async () => {
    const graph = getGraph()
    const first = await extractFromDirectory(graph, FIXTURES)
    const before = graph.edges().filter((id) => id.startsWith('IMPORTS:')).length

    const second = await extractFromDirectory(graph, FIXTURES)
    const after = graph.edges().filter((id) => id.startsWith('IMPORTS:')).length

    expect(after).toBe(before)
    expect(first.edgesAdded).toBeGreaterThan(0)
    expect(second.edgesAdded).toBe(0)
  })
})
