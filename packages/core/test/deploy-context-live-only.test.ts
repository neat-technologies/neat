import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { mergeObservedDeployContext } from '../src/ingest.js'
import { migrateSnapshot, saveGraphToDisk, SCHEMA_VERSION, type PersistedGraph } from '../src/persist.js'

// The faulted workload's redacted env/args/process log lives on the running graph only
// (ADR-241, connectors.md §6): every surface reads it there, but no snapshot carries it
// out or brings it in.
const svc = 'service:recommendation'
const ctx = { fault: 'crash-loop', containerEnv: ['NEO4J_PRODUCT_DATABASE_ENDPOINT=master-neo4j-productdb:7979'] }

function graphWithContext(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode(svc, { id: svc, type: 'ServiceNode', name: 'recommendation', language: 'python' } as unknown as GraphNode)
  mergeObservedDeployContext(g, svc, 'k8s:deploy:otel-demo:recommendation:crash-loop', '2026-10-11T10:00:00.000Z', ctx)
  return g
}

describe('observedDeployContext is live-only (ADR-241)', () => {
  it('is never written to a snapshot, and the live node keeps it', async () => {
    const g = graphWithContext()
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'neat-live-only-')), 'graph.json')
    await saveGraphToDisk(g, out)
    const written = readFileSync(out, 'utf8')
    expect(written).toContain('recommendation')
    expect(written).not.toContain('observedDeployContext')
    expect(written).not.toContain('master-neo4j-productdb')
    // Saving must not strip the running graph.
    expect((g.getNodeAttributes(svc) as { observedDeployContext?: unknown }).observedDeployContext).toBeDefined()
  })

  it('is dropped from an incoming snapshot, so a snapshot can never set it', () => {
    const g = graphWithContext()
    const incoming: PersistedGraph = { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), graph: g.export() } as PersistedGraph
    const migrated = migrateSnapshot(incoming)
    expect(JSON.stringify(migrated)).not.toContain('observedDeployContext')
  })
})
