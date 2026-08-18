import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SymbolNode } from '@neat.is/types'
import { NodeType, symbolId } from '@neat.is/types'
import { discoverServices } from '../src/extract/services.js'
import { extractFromDirectory } from '../src/extract.js'
import { getGraph, resetGraph } from '../src/graph.js'

// ADR-200 — nearest-service-wins file ownership. A source file belongs to the
// deepest discovered service that contains it. When the root `package.json` has a
// name but no `workspaces`, the root becomes a service at the scan root *and* the
// recursive walk discovers every nested service under it. Without ownership the
// root's file walk re-visits each nested subtree and re-mints its symbols under
// the root — inert repo-relative phantoms that double-count every nested service
// (on the otel-demo extract the root JS service held 870 `.go` / 191 `.py`
// symbols that belonged to its sub-services). This suite pins the fix: an ancestor
// claims none of a nested service's files; each nested service claims its own; no
// symbol is minted twice.
describe('nearest-service ownership (ADR-200)', () => {
  const originalScanDepth = process.env.NEAT_SCAN_DEPTH
  let tmp: string

  beforeEach(() => {
    delete process.env.NEAT_SCAN_DEPTH
  })

  afterEach(async () => {
    if (originalScanDepth === undefined) delete process.env.NEAT_SCAN_DEPTH
    else process.env.NEAT_SCAN_DEPTH = originalScanDepth
    if (tmp) await fs.rm(tmp, { recursive: true, force: true })
  })

  // Root JS service (name, NO workspaces) with two nested services in different
  // languages: a JS sub-service under src/svc-a and a Python sub-service under
  // src/py-svc. Each carries a uniquely named definition so we can trace exactly
  // which service minted which symbol.
  async function buildNestedTree(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-owner-'))
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture-root', version: '1.0.0' }),
    )
    // Root's own source — owned by the root service.
    await fs.writeFile(path.join(root, 'index.js'), 'function rootHandler() {\n  return 1\n}\n')

    // Nested JS service under src/svc-a.
    const svcA = path.join(root, 'src', 'svc-a')
    await fs.mkdir(svcA, { recursive: true })
    await fs.writeFile(
      path.join(svcA, 'package.json'),
      JSON.stringify({ name: 'fixture-svc-a', version: '1.0.0' }),
    )
    await fs.writeFile(path.join(svcA, 'index.js'), 'function svcAHandler() {\n  return 2\n}\n')

    // Nested Python service under src/py-svc.
    const pySvc = path.join(root, 'src', 'py-svc')
    await fs.mkdir(pySvc, { recursive: true })
    await fs.writeFile(
      path.join(pySvc, 'pyproject.toml'),
      '[tool.poetry]\nname = "fixture-py-svc"\nversion = "1.0.0"\n',
    )
    await fs.writeFile(path.join(pySvc, 'main.py'), 'def pySvcHandler():\n    return 3\n')

    return root
  }

  // All SymbolNodes as { service, relPath, qualname } triples.
  function symbolTriples(): { service: string; relPath: string; qualname: string }[] {
    const graph = getGraph()
    const out: { service: string; relPath: string; qualname: string }[] = []
    graph.forEachNode((_id, attrs) => {
      const a = attrs as SymbolNode
      if (a.type === NodeType.SymbolNode) {
        out.push({ service: a.service, relPath: a.relPath, qualname: a.qualname })
      }
    })
    return out
  }

  it('records each nested service dir on the root service excludeDirs', async () => {
    tmp = await buildNestedTree()
    const services = await discoverServices(tmp)

    const byName = new Map(services.map((s) => [s.node.name, s]))
    expect([...byName.keys()].sort()).toEqual(['fixture-py-svc', 'fixture-root', 'fixture-svc-a'])

    const root = byName.get('fixture-root')!
    const rootExcludes = new Set(root.excludeDirs ?? [])
    expect(rootExcludes.has(path.resolve(tmp, 'src', 'svc-a'))).toBe(true)
    expect(rootExcludes.has(path.resolve(tmp, 'src', 'py-svc'))).toBe(true)

    // Leaf services nest nothing, so they exclude nothing.
    expect(byName.get('fixture-svc-a')!.excludeDirs).toEqual([])
    expect(byName.get('fixture-py-svc')!.excludeDirs).toEqual([])
  })

  it('the root service claims none of the nested services files; each nested service claims its own', async () => {
    tmp = await buildNestedTree()
    resetGraph()
    const graph = getGraph()
    await extractFromDirectory(graph, tmp)

    // The root claims its own top-level source.
    expect(graph.hasNode(symbolId('fixture-root', 'index.js', 'rootHandler'))).toBe(true)

    // The root does NOT re-mint the nested services' symbols under itself — this
    // is the phantom-node duplication the fix removes.
    expect(
      graph.hasNode(symbolId('fixture-root', 'src/svc-a/index.js', 'svcAHandler')),
      'root must not own the nested JS symbol',
    ).toBe(false)
    expect(
      graph.hasNode(symbolId('fixture-root', 'src/py-svc/main.py', 'pySvcHandler')),
      'root must not own the nested Python symbol',
    ).toBe(false)

    // Each nested service owns its own symbol, service-relative.
    expect(graph.hasNode(symbolId('fixture-svc-a', 'index.js', 'svcAHandler'))).toBe(true)
    expect(graph.hasNode(symbolId('fixture-py-svc', 'main.py', 'pySvcHandler'))).toBe(true)
  })

  it('mints every symbol exactly once — no duplicates across services', async () => {
    tmp = await buildNestedTree()
    resetGraph()
    const graph = getGraph()
    await extractFromDirectory(graph, tmp)

    const byQual = new Map<string, string[]>()
    for (const { service, qualname } of symbolTriples()) {
      byQual.set(qualname, [...(byQual.get(qualname) ?? []), service])
    }

    // Exactly one owner per definition, and it is the nearest (deepest) service.
    expect(byQual.get('rootHandler')).toEqual(['fixture-root'])
    expect(byQual.get('svcAHandler')).toEqual(['fixture-svc-a'])
    expect(byQual.get('pySvcHandler')).toEqual(['fixture-py-svc'])

    // And no SymbolNode is attributed to the root under a nested subtree path.
    const rootUnderNested = symbolTriples().filter(
      (s) =>
        s.service === 'fixture-root' &&
        (s.relPath.startsWith('src/svc-a/') || s.relPath.startsWith('src/py-svc/')),
    )
    expect(rootUnderNested).toEqual([])
  })

  // Regression guard for the fallback recursive walk: a single-service repo with
  // NO nested manifests must still walk its whole tree and symbol-grain source in
  // nested plain directories (nothing is excluded when nothing is nested).
  it('a single-service repo with no nested services still extracts source from subdirectories', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-owner-solo-'))
    await fs.writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'fixture-root-solo', version: '1.0.0' }),
    )
    const lib = path.join(tmp, 'src', 'lib')
    await fs.mkdir(lib, { recursive: true })
    await fs.writeFile(path.join(lib, 'util.js'), 'function helper() {\n  return 1\n}\n')

    const services = await discoverServices(tmp)
    expect(services).toHaveLength(1)
    expect(services[0]!.excludeDirs).toEqual([])

    resetGraph()
    const graph = getGraph()
    await extractFromDirectory(graph, tmp)

    // The deep file is grained under the sole service, service-relative.
    expect(graph.hasNode(symbolId('fixture-root-solo', 'src/lib/util.js', 'helper'))).toBe(true)
  })
})
