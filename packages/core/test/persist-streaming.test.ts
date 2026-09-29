import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NodeType, Provenance, EdgeType } from '@neat.is/types'
import { getGraph, resetGraph } from '../src/graph.js'
import {
  saveGraphToDisk,
  loadGraphFromDisk,
  serializeGraphChunks,
  SCHEMA_VERSION,
  type PersistedGraph,
} from '../src/persist.js'

// #1254 — `JSON.stringify` on a whole large graph hits V8's ~2^29-character cap
// and throws `RangeError: Invalid string length`, so extraction succeeds and the
// snapshot is lost. The writer streams the two unbounded arrays instead. The
// load-bearing property is that the bytes did not change: every reader, every
// migration and the daemon's snapshot push all still see the same file.

const tmpDirs: string[] = []

async function makeDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-persist-'))
  const real = await fs.realpath(d)
  tmpDirs.push(real)
  return real
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

let graphSeq = 0
function buildGraph(services: number) {
  const key = `persist-test-${graphSeq++}`
  resetGraph(key)
  const graph = getGraph(key)
  for (let i = 0; i < services; i++) {
    const svc = `service:svc-${i}`
    const file = `file:svc-${i}:src/index.ts`
    graph.addNode(svc, { type: NodeType.ServiceNode, name: `svc-${i}`, language: 'typescript' })
    graph.addNode(file, { type: NodeType.FileNode, path: 'src/index.ts', service: `svc-${i}` })
    graph.addEdgeWithKey(`CONTAINS:${svc}->${file}`, svc, file, {
      type: EdgeType.CONTAINS,
      provenance: Provenance.EXTRACTED,
      confidence: 0.5,
    })
  }
  return graph
}

function payloadFor(graph: ReturnType<typeof buildGraph>, exportedAt: string): PersistedGraph {
  return { schemaVersion: SCHEMA_VERSION, exportedAt, graph: graph.export() }
}

describe('serializeGraphChunks', () => {
  it('concatenates to exactly what JSON.stringify would have produced', () => {
    const payload = payloadFor(buildGraph(40), '2026-09-29T00:00:00.000Z')
    expect([...serializeGraphChunks(payload)].join('')).toBe(JSON.stringify(payload))
  })

  it('matches JSON.stringify on an empty graph too', () => {
    const payload = payloadFor(buildGraph(0), '2026-09-29T00:00:00.000Z')
    expect([...serializeGraphChunks(payload)].join('')).toBe(JSON.stringify(payload))
  })

  it('omits an undefined-valued key, the way an object literal does', () => {
    // JSON.stringify drops such a key entirely — comma included. An array would
    // instead write null, so the two containers must not share a rule.
    const payload = {
      schemaVersion: 7,
      exportedAt: undefined,
      graph: { options: {}, attributes: {}, nodes: [], edges: [] },
    } as unknown as PersistedGraph
    expect([...serializeGraphChunks(payload)].join('')).toBe(JSON.stringify(payload))
  })

  it('never emits the whole graph as one chunk — that is the point', () => {
    const payload = payloadFor(buildGraph(500), '2026-09-29T00:00:00.000Z')
    const chunks = [...serializeGraphChunks(payload)]
    const whole = JSON.stringify(payload)
    expect(chunks.length).toBeGreaterThan(1000)
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThan(whole.length / 10)
  })
})

describe('saveGraphToDisk', () => {
  it('writes bytes identical to the single-stringify version, and loads back', async () => {
    const dir = await makeDir()
    const out = path.join(dir, 'neat-out', 'graph.json')
    const graph = buildGraph(60)
    await saveGraphToDisk(graph, out)

    const written = await fs.readFile(out, 'utf8')
    const parsed = JSON.parse(written) as PersistedGraph
    // Same bytes as stringifying the payload that was actually written — the
    // timestamp is the one field generated inside save, so reuse it.
    expect(written).toBe(JSON.stringify(payloadFor(graph, parsed.exportedAt)))

    const restored = getGraph(`restore-${graphSeq++}`)
    await loadGraphFromDisk(restored, out)
    expect(restored.order).toBe(graph.order)
    expect(restored.size).toBe(graph.size)
  })

  it('leaves no .tmp behind and keeps the write atomic', async () => {
    const dir = await makeDir()
    const out = path.join(dir, 'neat-out', 'graph.json')
    await saveGraphToDisk(buildGraph(5), out)
    const entries = await fs.readdir(path.dirname(out))
    expect(entries).toContain('graph.json')
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
  })

  it('survives a serializer ceiling that the old single-call write would have hit', async () => {
    // Standing in for V8's ~2^29 cap without building a 512MB string in CI:
    // JSON.stringify throws for any argument over a small budget, which is
    // exactly the shape of the real failure. The streaming writer only ever
    // stringifies one node or edge at a time, so it stays under it; a whole-
    // payload call would not.
    const dir = await makeDir()
    const out = path.join(dir, 'neat-out', 'graph.json')
    const graph = buildGraph(200)
    const payload = payloadFor(graph, '2026-09-29T00:00:00.000Z')
    const whole = JSON.stringify(payload)
    const CEILING = 4096
    expect(whole.length).toBeGreaterThan(CEILING) // the old path would have thrown

    const real = JSON.stringify
    const spy = ((value: unknown, ...rest: unknown[]) => {
      const s = (real as (...a: unknown[]) => string | undefined)(value, ...(rest as []))
      if (typeof s === 'string' && s.length > CEILING) {
        throw new RangeError('Invalid string length')
      }
      return s
    }) as typeof JSON.stringify
    JSON.stringify = spy
    try {
      await saveGraphToDisk(graph, out)
    } finally {
      JSON.stringify = real
    }

    const restored = getGraph(`restore-${graphSeq++}`)
    await loadGraphFromDisk(restored, out)
    expect(restored.order).toBe(graph.order)
    expect(restored.size).toBe(graph.size)
  })
})
