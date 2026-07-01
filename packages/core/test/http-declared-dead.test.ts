import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { computeDivergences } from '../src/divergences.js'
import { EdgeType, Provenance, type GraphEdge } from '@neat.is/types'

// A declared-but-dead HTTP dependency: service-a names another in-mesh service's
// URL in source but that service never runs, so no OBSERVED traffic exists. The
// URL-literal CALLS edge must clear the precision floor (url-literal-service-
// target, 0.7) so it enters the EXTRACTED layer and missing-observed can flag
// the dead dependency — the OBSERVED-thesis case that was invisible before
// (#592).
describe('declared-but-dead HTTP dependency (#592)', () => {
  let dir: string

  beforeEach(async () => {
    resetGraph()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-dead-http-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function writeProject(): Promise<void> {
    const a = path.join(dir, 'service-a')
    await fs.mkdir(a, { recursive: true })
    await fs.writeFile(
      path.join(a, 'package.json'),
      JSON.stringify({ name: 'service-a', version: '1.0.0' }),
    )
    await fs.writeFile(
      path.join(a, 'index.js'),
      [
        "const url = 'http://service-c:3102/tasks'",
        'async function run() {',
        '  return fetch(url)',
        '}',
        'module.exports = { run }',
        '',
      ].join('\n'),
    )

    // service-c is a registered service but is never started (no OTel).
    const c = path.join(dir, 'service-c')
    await fs.mkdir(c, { recursive: true })
    await fs.writeFile(
      path.join(c, 'package.json'),
      JSON.stringify({ name: 'service-c', version: '1.0.0' }),
    )
    await fs.writeFile(path.join(c, 'index.js'), 'module.exports = {}\n')
  }

  it('recovers the URL-literal CALLS edge above the floor so it enters the graph', async () => {
    await writeProject()
    const graph = getGraph()
    await extractFromDirectory(graph, dir)

    const callEdges = graph
      .edges()
      .map((e) => graph.getEdgeAttributes(e) as GraphEdge)
      .filter(
        (e) =>
          e.type === EdgeType.CALLS &&
          e.provenance === Provenance.EXTRACTED &&
          e.source.startsWith('file:service-a:') &&
          e.target === 'service:service-c',
      )
    expect(callEdges.length).toBeGreaterThanOrEqual(1)
    expect(callEdges[0]!.confidence).toBeCloseTo(0.7, 2)
  })

  it('surfaces the dead dependency as a missing-observed divergence', async () => {
    await writeProject()
    const graph = getGraph()
    await extractFromDirectory(graph, dir)

    const result = computeDivergences(graph)
    const dead = result.divergences.find(
      (d) => d.type === 'missing-observed' && d.target === 'service:service-c',
    )
    expect(dead).toBeDefined()
  })
})
