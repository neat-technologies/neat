import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { EdgeType, extractedEdgeId, fileId } from '@neat.is/types'
import type { GraphEdge } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'imports')
// A one-service tree whose only file imports itself — kept apart from FIXTURES
// so the self-loop case is exercised in isolation (#1004).
const FIXTURES_SELF = path.resolve(__dirname, 'fixtures', 'imports-self')

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

  it('resolves a two-dot Python relative import to its parent-package target, not a self-loop (#457)', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, FIXTURES)

    // app/api/jobs.py: `from ..jobs import get_job` walks up past the `api`
    // package to app/jobs.py. tree-sitter-python groups `..` into a single
    // import_prefix node with two `.` children — counting nodes instead of
    // dots under-resolves to level=1 and lands back on the importer itself,
    // which addImports rejects as a self-loop (UsageGraphError).
    const edgeId =
      'IMPORTS:file:fixture-imports-py-service:app/api/jobs.py->file:fixture-imports-py-service:app/jobs.py'
    expect(graph.hasEdge(edgeId)).toBe(true)

    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.source).not.toBe(edge.target)
    expect(edge.provenance).toBe('EXTRACTED')
    expect(edge.evidence?.file).toBe('app/api/jobs.py')
    expect(edge.evidence?.snippet).toContain('get_job')
    expect(result.extractionErrors).toBe(0)
  })

  it('resolves `from PKG import NAME` to the submodule file, one edge per name', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // app/registry.py does `from app import config` and `from app import db`.
    // Each names a submodule (app/config.py, app/db.py), not a symbol on
    // app/__init__.py. Resolving both onto __init__.py collapsed them into a
    // single edge — the second dependency went invisible to dedup.
    const configEdge =
      'IMPORTS:file:fixture-imports-py-service:app/registry.py->file:fixture-imports-py-service:app/config.py'
    const dbEdge =
      'IMPORTS:file:fixture-imports-py-service:app/registry.py->file:fixture-imports-py-service:app/db.py'

    expect(graph.hasEdge(configEdge)).toBe(true)
    expect(graph.hasEdge(dbEdge)).toBe(true)

    // Nothing should land on the package __init__.py — config/db are submodules.
    expect(
      graph.hasEdge(
        'IMPORTS:file:fixture-imports-py-service:app/registry.py->file:fixture-imports-py-service:app/__init__.py',
      ),
    ).toBe(false)

    const edge = graph.getEdgeAttributes(configEdge) as GraphEdge
    expect(edge.provenance).toBe('EXTRACTED')
    expect(edge.evidence?.file).toBe('app/registry.py')
    expect(edge.evidence?.snippet).toContain('config')

    // app/db.py imports config too, so blast-radius/dependencies see config.py
    // as a real upstream — not a zero-edge orphan.
    expect(
      graph.hasEdge(
        'IMPORTS:file:fixture-imports-py-service:app/db.py->file:fixture-imports-py-service:app/config.py',
      ),
    ).toBe(true)
  })

  it('skips a self-referential import without throwing or minting a self-loop (#1004)', async () => {
    const graph = getGraph()

    // self-service/index.ts does `import './index.js'`, which resolves back to
    // index.ts itself. graphology has allowSelfLoops off, so emitting that edge
    // throws — and that throw used to escape addImports and abort the whole
    // pass. The guard turns the self-import into a silent non-edge instead.
    const result = await extractFromDirectory(graph, FIXTURES_SELF)

    const selfFileId = fileId('fixture-imports-self-service', 'index.ts')
    // The file was still walked — extraction didn't die partway through.
    expect(graph.hasNode(selfFileId)).toBe(true)
    // No IMPORTS self-loop on it, and the skip isn't logged as a per-file error.
    expect(graph.hasEdge(extractedEdgeId(selfFileId, selfFileId, EdgeType.IMPORTS))).toBe(false)
    expect(graph.edges().filter((id) => id.startsWith('IMPORTS:'))).toHaveLength(0)
    expect(result.extractionErrors).toBe(0)
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
