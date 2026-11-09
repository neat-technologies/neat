import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeType } from '@neat.is/types'

// tree-sitter-kotlin ships no prebuilt binary, so on a machine without a C
// compiler (Windows without Visual Studio's C++ tools) its install fails. It is
// an optional dependency: this file simulates that machine, where requiring the
// grammar throws, and the rest of extraction must still run, keep the .kt files
// at file grain, and say once that Kotlin symbols were skipped.

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  const createRequire = (from: string | URL) => {
    const req = actual.createRequire(from)
    const wrapped = ((id: string) => {
      if (id === 'tree-sitter-kotlin') throw new Error('No native build was found for tree-sitter-kotlin')
      return req(id)
    }) as NodeJS.Require
    return Object.assign(wrapped, req)
  }
  return { ...actual, createRequire, default: { ...actual, createRequire } }
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'symbols-polyglot')

describe('Kotlin grammar missing (optional dependency not built)', () => {
  it('extraction still runs: other languages mint symbols, .kt keeps file grain, one notice', async () => {
    const { resetGraph, getGraph } = await import('../src/graph.js')
    const { extractFromDirectory } = await import('../src/extract.js')
    const { drainExtractionErrors } = await import('../src/extract/errors.js')
    const { SYMBOL_GRAMMAR_BY_EXT, KOTLIN_UNAVAILABLE } = await import('../src/extract/symbols.js')
    expect(SYMBOL_GRAMMAR_BY_EXT['.kt']).toBeUndefined()

    resetGraph()
    drainExtractionErrors()
    const graph = getGraph()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await extractFromDirectory(graph, FIXTURES)
    warn.mockRestore()

    const nodes = graph.mapNodes((_id, attrs) => attrs as { type: string; file?: string; path?: string; id: string })
    const symbols = nodes.filter((n) => n.type === NodeType.SymbolNode)
    expect(symbols.some((n) => String(n.id).includes('.kt'))).toBe(false)
    expect(symbols.length).toBeGreaterThan(0)
    expect(nodes.some((n) => n.type === NodeType.FileNode && String(n.id).endsWith('.kt'))).toBe(true)

    const notes = result.errorEntries.filter((e) => e.error === KOTLIN_UNAVAILABLE)
    expect(notes).toHaveLength(1)
  })
})
