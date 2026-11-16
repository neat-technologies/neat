import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { makeGraph, type NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { declaringGraph, declared, declarersWith, declarersWithout } from '../src/extract/declare.js'
import { retireExtractedEdgesByMissingFile } from '../src/extract/retire.js'
import { migrateSnapshot, SCHEMA_VERSION, type PersistedGraph } from '../src/persist.js'
import { EdgeType, NodeType, Provenance, type GraphEdge, type GraphNode } from '@neat.is/types'

// #1729 (#1698 slice zero): every static node and EXTRACTED edge records the
// repositories whose extraction pass declared it, in `declaredBy`.

const dirs: string[] = []
async function repoDir(name: string, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `neat-${name}-`))
  dirs.push(dir)
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, body, 'utf8')
  }
  return dir
}
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

function serviceRepo(svcDir: string, svcName: string, entry: string): Record<string, string> {
  return {
    [`${svcDir}/package.json`]: JSON.stringify({ name: svcName, version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
    [`${svcDir}/${entry}`]: [
      "const pad = require('left-pad')",
      'function helper(n) { return pad(String(n), 3) }',
      'function main() { return helper(1) }',
      'module.exports = { main, helper }',
    ].join('\n'),
  }
}
const quiet = { announce: false } as const

function declarersOf(g: NeatGraph, kind: 'node' | 'edge', id: string): string[] | undefined {
  return kind === 'node' ? g.getNodeAttributes(id).declaredBy : g.getEdgeAttributes(id).declaredBy
}

describe('declaredBy is stamped by the pass that declares an element', () => {
  it('stamps every static node and EXTRACTED edge of a sourced pass, and nothing for a sourceless one', async () => {
    const dir = await repoDir('a', serviceRepo('svc-a', 'alpha', 'a.js'))
    const g = makeGraph()
    await extractFromDirectory(g, dir, { ...quiet, source: 'org/a' })
    let nodes = 0, edges = 0
    g.forEachNode((id, a) => { nodes++; expect(a.declaredBy, id).toEqual(['org/a']) })
    g.forEachEdge((id, a) => { if (a.provenance === Provenance.EXTRACTED) { edges++; expect(a.declaredBy, id).toEqual(['org/a']) } })
    expect(nodes).toBeGreaterThan(3)
    expect(edges).toBeGreaterThan(2)

    const bare = makeGraph()
    await extractFromDirectory(bare, dir, quiet)
    bare.forEachNode((id, a) => expect(a.declaredBy, id).toBeUndefined())
    bare.forEachEdge((id, a) => expect(a.declaredBy, id).toBeUndefined())
  })

  it('records both repositories on a service both declare, and keeps each repo\'s own code to itself', async () => {
    const a = await repoDir('a', serviceRepo('svc-a', 'shared', 'from-a.js'))
    const b = await repoDir('b', serviceRepo('svc-b', 'shared', 'from-b.js'))
    const g = makeGraph()
    await extractFromDirectory(g, a, { ...quiet, source: 'org/a' })
    await extractFromDirectory(g, b, { ...quiet, source: 'org/b' })
    const service = g.filterNodes((_, n) => n.type === NodeType.ServiceNode)
    expect(service).toHaveLength(1)
    expect(declarersOf(g, 'node', service[0]!)).toEqual(['org/a', 'org/b'])
    const fileA = g.filterNodes((_, n) => n.type === NodeType.FileNode && (n as { path?: string }).path?.endsWith('from-a.js'))
    const fileB = g.filterNodes((_, n) => n.type === NodeType.FileNode && (n as { path?: string }).path?.endsWith('from-b.js'))
    expect(fileA.map((id) => declarersOf(g, 'node', id))).toEqual([['org/a']])
    expect(fileB.map((id) => declarersOf(g, 'node', id))).toEqual([['org/b']])
  })

  it('a repeated pass by the same repository keeps one entry', async () => {
    const dir = await repoDir('a', serviceRepo('svc-a', 'alpha', 'a.js'))
    const g = makeGraph()
    await extractFromDirectory(g, dir, { ...quiet, source: 'org/a' })
    await extractFromDirectory(g, dir, { ...quiet, source: 'org/a' })
    g.forEachNode((id, a) => expect(a.declaredBy, id).toEqual(['org/a']))
  })
})

describe('the declaring handle', () => {
  const svc = (id: string, extra: Partial<GraphNode> = {}) => ({ id, type: NodeType.ServiceNode, name: id, language: 'javascript', ...extra }) as GraphNode

  it('stamps only what is written or marked through the handle, never a write to the live graph', () => {
    const g = makeGraph()
    const pass = declaringGraph(g, 'org/a')
    pass.graph.addNode('service:x', svc('service:x'))
    g.addNode('service:runtime', svc('service:runtime', { discoveredVia: 'otel' } as Partial<GraphNode>))
    g.addNode('service:other', svc('service:other'))
    declared(pass.graph, 'node', 'service:other')
    declared(pass.graph, 'node', 'service:absent')
    expect(pass.finish()).toEqual({ nodes: 2, edges: 0 })
    expect(declarersOf(g, 'node', 'service:x')).toEqual(['org/a'])
    expect(declarersOf(g, 'node', 'service:other')).toEqual(['org/a'])
    expect(declarersOf(g, 'node', 'service:runtime')).toBeUndefined()
  })

  it('carries recorded declarers through a whole-object replace', () => {
    const g = makeGraph()
    g.addNode('service:x', { ...svc('service:x'), declaredBy: ['org/a'] })
    const pass = declaringGraph(g, 'org/b')
    pass.graph.replaceNodeAttributes('service:x', svc('service:x', { language: 'typescript' } as Partial<GraphNode>))
    pass.finish()
    expect(declarersOf(g, 'node', 'service:x')).toEqual(['org/a', 'org/b'])
  })

  it('never stamps a non-EXTRACTED edge', () => {
    const g = makeGraph()
    g.addNode('service:x', svc('service:x')); g.addNode('service:y', svc('service:y'))
    const pass = declaringGraph(g, 'org/a')
    const edge: GraphEdge = { id: 'obs', source: 'service:x', target: 'service:y', type: EdgeType.CALLS, provenance: Provenance.OBSERVED }
    pass.graph.addEdgeWithKey('obs', 'service:x', 'service:y', edge)
    pass.finish()
    expect(declarersOf(g, 'edge', 'obs')).toBeUndefined()
  })

  it('is a plain pass-through without a source', () => {
    const g = makeGraph()
    const pass = declaringGraph(g, undefined)
    expect(pass.graph).toBe(g)
    declared(g, 'node', 'anything')
    expect(pass.finish()).toEqual({ nodes: 0, edges: 0 })
  })

  it('keeps declarer lists sorted and unique', () => {
    expect(declarersWith(['org/b'], 'org/a')).toEqual(['org/a', 'org/b'])
    const same = ['org/a']
    expect(declarersWith(same, 'org/a')).toBe(same)
    expect(declarersWithout(['org/a', 'org/b'], 'org/a')).toEqual(['org/b'])
    expect(declarersWithout(['org/a'], 'org/a')).toBeUndefined()
  })
})

describe('the retire sweep reads recorded declarers', () => {
  function edgeGraph(declaredBy: string[] | undefined): NeatGraph {
    const g = makeGraph()
    for (const id of ['symbol:s:gone.js#f', 'symbol:s:gone.js#g']) g.addNode(id, { id, type: NodeType.SymbolNode, name: id, service: 's', path: 'gone.js', kind: 'function' } as unknown as GraphNode)
    const e: GraphEdge = { id: 'calls', source: 'symbol:s:gone.js#f', target: 'symbol:s:gone.js#g', type: EdgeType.CALLS, provenance: Provenance.EXTRACTED, evidence: { file: 'gone.js' }, ...(declaredBy ? { declaredBy } : {}) }
    g.addEdgeWithKey('calls', e.source, e.target, e)
    return g
  }

  it('withdraws only its own declaration from an edge another repository also declares', async () => {
    const root = await repoDir('empty', { 'keep.txt': '' })
    const g = edgeGraph(['org/a', 'org/b'])
    expect(retireExtractedEdgesByMissingFile(g, root, [], 'org/b')).toBe(0)
    expect(declarersOf(g, 'edge', 'calls')).toEqual(['org/a'])
  })

  it('drops an edge only this pass declared', async () => {
    const root = await repoDir('empty', { 'keep.txt': '' })
    const g = edgeGraph(['org/b'])
    expect(retireExtractedEdgesByMissingFile(g, root, [], 'org/b')).toBe(1)
    expect(g.hasEdge('calls')).toBe(false)
  })

  it('leaves another repository\'s edge alone even when its file is missing here', async () => {
    const root = await repoDir('empty', { 'keep.txt': '' })
    const g = edgeGraph(['org/a'])
    expect(retireExtractedEdgesByMissingFile(g, root, [], 'org/b')).toBe(0)
    expect(declarersOf(g, 'edge', 'calls')).toEqual(['org/a'])
  })
})

describe('v9 to v10 migration', () => {
  it('seeds a FileNode\'s declarers from its source, leaves the rest unknown, and is idempotent', () => {
    const v9 = {
      schemaVersion: 9,
      exportedAt: '2026-11-16T00:00:00.000Z',
      graph: {
        options: { type: 'directed', multi: true, allowSelfLoops: false },
        attributes: {},
        nodes: [
          { key: 'file:s:a.js', attributes: { id: 'file:s:a.js', type: NodeType.FileNode, service: 's', path: 'a.js', source: 'org/a' } },
          { key: 'file:s:b.js', attributes: { id: 'file:s:b.js', type: NodeType.FileNode, service: 's', path: 'b.js' } },
          { key: 'service:s', attributes: { id: 'service:s', type: NodeType.ServiceNode, name: 's', language: 'javascript' } },
        ],
        edges: [],
      },
    } as unknown as PersistedGraph
    const once = migrateSnapshot(structuredClone(v9))
    expect(once.schemaVersion).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBe(10)
    const attrs = (once.graph as { nodes: Array<{ key: string; attributes: Record<string, unknown> }> }).nodes
    expect(attrs.find((n) => n.key === 'file:s:a.js')!.attributes.declaredBy).toEqual(['org/a'])
    expect(attrs.find((n) => n.key === 'file:s:b.js')!.attributes.declaredBy).toBeUndefined()
    expect(attrs.find((n) => n.key === 'service:s')!.attributes.declaredBy).toBeUndefined()
    expect(migrateSnapshot(structuredClone(once))).toEqual(once)
  })
})
