import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import { extractFromDirectory } from '../src/extract.js'
import type { NeatGraph } from '../src/graph.js'

// #1291 — the ghost sweep at the end of an extraction pass drops every EXTRACTED
// edge whose file isn't under the pass's scan root. A hosted tenant restored
// from a snapshot boots with its repos not yet synced, so the boot pass scanned
// a root with no source in it and the sweep took the whole restored code layer.
//
// The rule: a pass that found no source retires nothing. A pass that did find
// source still retires what is really gone.

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true })
})

const newGraph = (): NeatGraph => new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neat-retire-'))
  dirs.push(dir)
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await writeFile(path.join(dir, file), content)
  }
  return dir
}

const pkg = (name: string): string =>
  JSON.stringify({ name, version: '1.0.0', dependencies: { express: '^4', pg: '^8' } })

const repoA = (): Promise<string> =>
  tree({
    'package.json': pkg('svc-a'),
    'src/index.js':
      "const db=require('./db');const axios=require('axios');require('express')().get('/x',async()=>{await axios.get('http://svc-b/api');db.q()}).listen(3000)",
    'src/db.js':
      "const {Pool}=require('pg');const p=new Pool({host:'db.internal',database:'app'});exports.q=()=>p.query('select * from users')",
  })

function extracted(graph: NeatGraph): string[] {
  const files: string[] = []
  graph.forEachEdge((_id, attrs) => {
    const edge = attrs as GraphEdge
    if (edge.provenance === 'EXTRACTED') files.push(edge.evidence?.file ?? '(no file)')
  })
  return files.sort()
}

const fileNodes = (graph: NeatGraph): number =>
  graph.filterNodes((_id, attrs) => (attrs as GraphNode).type === 'FileNode').length

describe('the ghost sweep and a root with no source (#1291)', () => {
  it('keeps a loaded graph whole when the pass finds nothing to scan', async () => {
    const graph = newGraph()
    await extractFromDirectory(graph, await repoA())
    const before = { edges: extracted(graph), files: fileNodes(graph), nodes: graph.order }
    expect(before.edges.length).toBeGreaterThan(0)
    expect(before.files).toBeGreaterThan(0)

    // The restored-tenant boot: same graph, a scan root that holds no source.
    const result = await extractFromDirectory(graph, await tree({}))

    expect(result.ghostsRetired).toBe(0)
    expect(extracted(graph)).toEqual(before.edges)
    expect(fileNodes(graph)).toBe(before.files)
    expect(graph.order).toBe(before.nodes)
  })

  it('still retires a deleted file when the pass is over the source it came from', async () => {
    const graph = newGraph()
    const dir = await repoA()
    await extractFromDirectory(graph, dir)
    const before = extracted(graph)
    expect(before).toContain('src/db.js')

    // No empty-root pass in between — the next pass is the repo itself, one file gone.
    await rm(path.join(dir, 'src/db.js'))
    await writeFile(path.join(dir, 'src/index.js'), "require('express')().get('/x',()=>1).listen(3000)")
    const result = await extractFromDirectory(graph, dir)

    expect(result.ghostsRetired).toBeGreaterThan(0)
    expect(extracted(graph)).not.toContain('src/db.js')
    expect(extracted(graph).length).toBeLessThan(before.length)
    expect(extracted(graph).length).toBeGreaterThan(0)
  })

  it('a root that does hold source is still taken at its word', async () => {
    // Out of scope for this rule, recorded so it isn't mistaken for covered: a
    // second source extracted into the same graph retires the first one's edges,
    // because its root has source and doesn't have those files. That is #1294.
    const graph = newGraph()
    await extractFromDirectory(graph, await repoA())
    const repoB = await tree({
      'package.json': pkg('svc-b'),
      'server/main.js':
        "const {Pool}=require('pg');const p=new Pool({host:'db2.internal',database:'other'});require('express')().get('/api',()=>p.query('select 1')).listen(3001)",
    })
    const result = await extractFromDirectory(graph, repoB)
    expect(result.ghostsRetired).toBeGreaterThan(0)
    expect(new Set(extracted(graph))).toEqual(new Set(['server/main.js']))
  })
})
