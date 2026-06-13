import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { saveGraphToDisk, loadGraphFromDisk, startPersistLoop } from '../src/persist.js'

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const DEMO_PATH = path.resolve(__dirname, '../../../demo')

describe('persistence', () => {
  let outPath: string

  beforeEach(async () => {
    resetGraph()
    outPath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), 'neat-persist-')),
      'graph.json',
    )
  })

  afterEach(async () => {
    await fs.rm(path.dirname(outPath), { recursive: true, force: true })
  })

  it('saveGraphToDisk writes a valid JSON snapshot', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)
    await saveGraphToDisk(graph, outPath)

    const raw = await fs.readFile(outPath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.schemaVersion).toBe(4)
    expect(parsed.exportedAt).toBeTypeOf('string')
    expect(parsed.graph.nodes.length).toBeGreaterThanOrEqual(3)
    expect(parsed.graph.edges.length).toBeGreaterThanOrEqual(2)
  })

  it('round-trips a graph: save → load reproduces the same node and edge counts', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)
    const orderBefore = graph.order
    const sizeBefore = graph.size

    await saveGraphToDisk(graph, outPath)
    resetGraph()
    const restored = getGraph()
    await loadGraphFromDisk(restored, outPath)

    expect(restored.order).toBe(orderBefore)
    expect(restored.size).toBe(sizeBefore)
    expect(restored.hasNode('service:service-b')).toBe(true)
    expect(restored.hasNode('database:payments-db')).toBe(true)
  })

  it('round-trips node attributes (dependencies preserved)', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)
    await saveGraphToDisk(graph, outPath)

    resetGraph()
    const restored = getGraph()
    await loadGraphFromDisk(restored, outPath)

    const serviceB = restored.getNodeAttributes('service:service-b') as {
      dependencies?: Record<string, string>
    }
    expect(serviceB.dependencies?.pg).toBe('7.4.0')
  })

  it('migrates a v1 snapshot on load — strips pgDriverVersion, leaves the rest intact', async () => {
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    const v1Snapshot = {
      schemaVersion: 1,
      exportedAt: '2026-04-30T00:00:00.000Z',
      graph: {
        attributes: {},
        options: { allowSelfLoops: false, multi: true, type: 'directed' },
        nodes: [
          {
            key: 'service:service-b',
            attributes: {
              id: 'service:service-b',
              type: 'ServiceNode',
              name: 'service-b',
              language: 'javascript',
              pgDriverVersion: '7.4.0',
              dependencies: { pg: '7.4.0' },
            },
          },
        ],
        edges: [],
      },
    }
    await fs.writeFile(outPath, JSON.stringify(v1Snapshot))

    resetGraph()
    const restored = getGraph()
    await loadGraphFromDisk(restored, outPath)

    expect(restored.hasNode('service:service-b')).toBe(true)
    const attrs = restored.getNodeAttributes('service:service-b') as Record<string, unknown>
    expect(attrs.pgDriverVersion).toBeUndefined()
    expect((attrs.dependencies as Record<string, string>).pg).toBe('7.4.0')
  })

  it('writes atomically — only the final file lands, no .tmp leftover', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)
    await saveGraphToDisk(graph, outPath)

    const dir = path.dirname(outPath)
    const entries = await fs.readdir(dir)
    expect(entries).toContain('graph.json')
    expect(entries.find((e) => e.endsWith('.tmp'))).toBeUndefined()
  })

  it('loadGraphFromDisk on a non-existent file is a no-op (no throw)', async () => {
    const graph = getGraph()
    await expect(loadGraphFromDisk(graph, outPath)).resolves.toBeUndefined()
    expect(graph.order).toBe(0)
  })

  it('loadGraphFromDisk rejects an unsupported schemaVersion', async () => {
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.writeFile(
      outPath,
      JSON.stringify({ schemaVersion: 999, exportedAt: '', graph: { nodes: [], edges: [] } }),
    )
    await expect(loadGraphFromDisk(getGraph(), outPath)).rejects.toThrow(/schemaVersion/)
  })

  it('saveGraphToDisk creates the parent directory if missing', async () => {
    const nested = path.join(path.dirname(outPath), 'a', 'b', 'graph.json')
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)
    await expect(saveGraphToDisk(graph, nested)).resolves.toBeUndefined()
    await expect(fs.access(nested)).resolves.toBeUndefined()
  })

  it('startPersistLoop saves on its interval and the cleanup unhooks signals', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)

    const sigtermBefore = process.listenerCount('SIGTERM')
    const sigintBefore = process.listenerCount('SIGINT')

    const stop = startPersistLoop(graph, outPath, { intervalMs: 50 })
    try {
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1)
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1)

      await new Promise((r) => setTimeout(r, 120))
      const raw = await fs.readFile(outPath, 'utf8')
      expect(JSON.parse(raw).graph.nodes.length).toBeGreaterThan(0)
    } finally {
      stop()
    }

    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore)
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore)
  })

  it('startPersistLoop with exitOnSignal:false installs no signal handlers but still saves on its interval', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, DEMO_PATH)

    const sigtermBefore = process.listenerCount('SIGTERM')
    const sigintBefore = process.listenerCount('SIGINT')

    // The daemon owns shutdown, so its persist loops must not register a
    // process-exiting signal handler — that would race the daemon's teardown.
    const stop = startPersistLoop(graph, outPath, { intervalMs: 50, exitOnSignal: false })
    try {
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore)
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore)

      await new Promise((r) => setTimeout(r, 120))
      const raw = await fs.readFile(outPath, 'utf8')
      expect(JSON.parse(raw).graph.nodes.length).toBeGreaterThan(0)
    } finally {
      stop()
    }

    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore)
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore)
  })
})
