import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NodeType } from '@neat.is/types'
import { getGraph, resetGraph } from '../src/graph.js'
import { addFiles } from '../src/extract/files.js'
import type { DiscoveredService } from '../src/extract/shared.js'

function makeService(name: string, dir: string): DiscoveredService {
  return {
    pkg: { name },
    dir,
    node: {
      id: `service:${name}`,
      type: NodeType.ServiceNode,
      name,
      language: 'typescript',
      discoveredVia: 'static',
    },
  }
}

describe('addFiles — Phase 1 file enumeration', () => {
  let tmpDir: string

  beforeEach(async () => {
    resetGraph()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-files-test-'))
  })

  it('emits a FileNode and CONTAINS edge for every source file', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export {}')
    await fs.writeFile(path.join(tmpDir, 'utils.ts'), 'export {}')
    await fs.writeFile(path.join(tmpDir, 'helper.ts'), 'export {}')

    const graph = getGraph()
    const service = makeService('my-svc', tmpDir)
    graph.addNode(service.node.id, service.node)

    const result = await addFiles(graph, [service])

    expect(result.nodesAdded).toBe(3)
    expect(result.edgesAdded).toBe(3)

    expect(graph.hasNode('file:my-svc:index.ts')).toBe(true)
    expect(graph.hasNode('file:my-svc:utils.ts')).toBe(true)
    expect(graph.hasNode('file:my-svc:helper.ts')).toBe(true)

    const node = graph.getNodeAttributes('file:my-svc:index.ts') as { type: string; service: string; path: string }
    expect(node.type).toBe(NodeType.FileNode)
    expect(node.service).toBe('my-svc')

    expect(graph.hasEdge('CONTAINS:service:my-svc->file:my-svc:index.ts')).toBe(true)
    expect(graph.hasEdge('CONTAINS:service:my-svc->file:my-svc:utils.ts')).toBe(true)
    expect(graph.hasEdge('CONTAINS:service:my-svc->file:my-svc:helper.ts')).toBe(true)
  })

  it('includes files with no external call patterns (the unconditional guarantee)', async () => {
    await fs.writeFile(path.join(tmpDir, 'plain.ts'), 'const x = 1')

    const graph = getGraph()
    const service = makeService('my-svc', tmpDir)
    graph.addNode(service.node.id, service.node)

    const result = await addFiles(graph, [service])

    expect(result.nodesAdded).toBe(1)
    expect(graph.hasNode('file:my-svc:plain.ts')).toBe(true)
  })

  it('is idempotent — running twice produces the same node count', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.ts'), '')
    await fs.writeFile(path.join(tmpDir, 'b.ts'), '')

    const graph = getGraph()
    const service = makeService('my-svc', tmpDir)
    graph.addNode(service.node.id, service.node)

    const first = await addFiles(graph, [service])
    const second = await addFiles(graph, [service])

    expect(first.nodesAdded).toBe(2)
    expect(second.nodesAdded).toBe(0)
    expect(graph.order).toBe(3) // 1 service node + 2 file nodes
  })
})
