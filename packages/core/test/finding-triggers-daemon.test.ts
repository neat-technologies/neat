import { afterEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { EdgeType, FindingRowSchema, NodeType, Provenance, extractedEdgeId, serviceId, type GraphEdge, type GraphNode } from '@neat.is/types'
import { EVENT_BUS_CHANNEL, emitNeatEvent, eventBus, type NeatEventEnvelope } from '../src/events.js'
import { beginSourceExtraction, finishSourceExtraction } from '../src/extract/source-baseline.js'

// The daemon starts the findings loop with a slot's other loops and stops it
// with them (ADR-279, docs/contracts/finding-triggers.md §4).

const REPO = 'acme/app'
const SHA = 'c'.repeat(40)

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

describe('daemon findings loop', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!().catch(() => {})
  })

  it('records a finding that appears on a running slot, emits it, and stops with the slot', async () => {
    const saved = new Map<string, string | undefined>()
    for (const key of ['NEAT_HOME', 'PORT', 'OTEL_PORT', 'HOST', 'NEAT_AUTH_TOKEN', 'NEAT_ADVISORIES', 'NEAT_INCIDENT_DURABLE_TOKEN']) saved.set(key, process.env[key])
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neatd-findings-home-'))
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neatd-findings-proj-')))
    cleanups.push(async () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await fs.rm(dir, { recursive: true, force: true })
      await fs.rm(home, { recursive: true, force: true })
    })
    process.env.NEAT_HOME = home
    process.env.PORT = '0'
    process.env.OTEL_PORT = '0'
    process.env.HOST = '127.0.0.1'
    process.env.NEAT_ADVISORIES = 'off'
    delete process.env.NEAT_AUTH_TOKEN
    delete process.env.NEAT_INCIDENT_DURABLE_TOKEN
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'fnd', version: '0.0.0' }))
    const { addProject } = await import('../src/registry.js')
    await addProject({ name: 'fnd', path: dir, languages: ['javascript'] })

    const listenersBefore = eventBus.listenerCount(EVENT_BUS_CHANNEL)
    const { startDaemon } = await import('../src/daemon.js')
    const handle = await startDaemon({ bindListeners: false })
    cleanups.push(handle.stop)
    await handle.initialBootstrap
    const slot = handle.slots.get('fnd')!
    expect(slot.status).toBe('active')
    expect(eventBus.listenerCount(EVENT_BUS_CHANNEL)).toBe(listenersBefore + 1)
    const file = slot.paths.findingsPath!
    expect(path.dirname(file)).toBe(path.join(dir, 'neat-out'))

    // A local project has no commit, so the loop's first evaluation starts no ledger.
    await new Promise((resolve) => setTimeout(resolve, 1300))
    expect(existsSync(file)).toBe(false)

    // Give the slot what a hosted repo sync gives it: nodes declared by a
    // repository, and that repository's baseline ready at a commit.
    const graph = slot.graph
    for (const name of ['web', 'api']) {
      graph.addNode(serviceId(name), { id: serviceId(name), type: NodeType.ServiceNode, name, language: 'ts', declaredBy: [REPO] } as GraphNode)
    }
    const commit = { repository: REPO, sha: SHA }
    finishSourceExtraction(graph, beginSourceExtraction(graph, REPO, commit), REPO, commit, { extractionErrors: 0, skippedFiles: 0 })
    const announce = (): void =>
      emitNeatEvent({ type: 'extraction-complete', project: 'fnd', payload: { project: 'fnd', fileCount: 1, nodesAdded: 0, edgesAdded: 0 } })
    announce()
    expect(await waitFor(() => existsSync(file), 5000)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('')

    const findings: NeatEventEnvelope[] = []
    const listener = (e: NeatEventEnvelope): void => {
      if (e.type === 'finding') findings.push(e)
    }
    eventBus.on(EVENT_BUS_CHANNEL, listener)
    cleanups.push(async () => void eventBus.off(EVENT_BUS_CHANNEL, listener))
    const nodesBefore = graph.order
    const id = extractedEdgeId(serviceId('web'), serviceId('api'), EdgeType.CALLS)
    graph.addEdgeWithKey(id, serviceId('web'), serviceId('api'), {
      id, source: serviceId('web'), target: serviceId('api'), type: EdgeType.CALLS, provenance: Provenance.EXTRACTED, confidence: 0.85,
    } as GraphEdge)
    const edgesBefore = graph.size
    announce()
    expect(await waitFor(() => findings.length > 0, 5000)).toBe(true)
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => FindingRowSchema.parse(JSON.parse(l)))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'divergence', affectedNode: serviceId('web'), repository: REPO, sha: SHA, divergenceType: 'missing-observed' })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.project).toBe('fnd')
    expect(findings[0]!.payload).toEqual(rows[0])
    // Evaluation read the graph and left it as it was.
    expect(graph.order).toBe(nodesBefore)
    expect(graph.size).toBe(edgesBefore)

    eventBus.off(EVENT_BUS_CHANNEL, listener)
    await handle.stop()
    expect(eventBus.listenerCount(EVENT_BUS_CHANNEL)).toBe(listenersBefore)
  }, 30_000)
})
