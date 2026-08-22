import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  databaseId,
  extractedEdgeId,
  fileId,
  observedEdgeId,
  serviceId,
  type DatabaseNode,
  type GraphEdge,
  type GraphNode,
  type ServiceNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { computeDivergences } from '../src/divergences.js'

// Dead-code / flag-gated datastore probes (ADR-213, #1072). The otel-demo cart
// declares TWO redis stores: `valkey-cart` (env-configured, the real one it
// fuses with) and a hardcoded `"badhost:1234"` fault-injection probe that is
// flag-gated dead code and never connects. Both are EXTRACTED, both are
// unobserved twins of nothing — but only `badhost` is a false positive. The
// ranker must dampen the probe WITHOUT touching the real broken-dependency
// divergence (a host that was observed and went dark, or the sole/env store).
//
// The signature that separates them: a `missing-observed` on a CONNECTS_TO to a
// DatabaseNode is a probe when (1) the host came from a hardcoded literal,
// (2) production has never observed it, AND (3) the same service is/was observed
// talking to another store of the same engine. All three are required — dropping
// any one risks dampening a real never-observed dependency.

const CART = 'cart'
const CART_SVC = serviceId(CART)
const STORE_FILE = 'cartstore/ValkeyCartStore.cs'
const EXTRACTED_CONF = 0.85

function baseGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  return g
}

function addService(g: NeatGraph, name: string): void {
  const id = serviceId(name)
  g.addNode(id, {
    id,
    type: NodeType.ServiceNode,
    name,
    language: 'csharp',
  } as ServiceNode)
}

function addDatabase(
  g: NeatGraph,
  host: string,
  engine: string,
  discoveredVia?: 'static' | 'otel' | 'merged',
): string {
  const id = databaseId(host)
  g.addNode(id, {
    id,
    type: NodeType.DatabaseNode,
    name: host,
    engine,
    engineVersion: 'unknown',
    compatibleDrivers: [],
    host,
    ...(discoveredVia ? { discoveredVia } : {}),
  } as DatabaseNode)
  return id
}

// An EXTRACTED `file → database` CONNECTS_TO, carrying the host-source marker the
// recogniser stamps (csharp.ts / ADR-207).
function addDeclaredConnection(
  g: NeatGraph,
  serviceName: string,
  relFile: string,
  dbId: string,
  hostSource: 'literal' | 'config',
): void {
  const src = fileId(serviceName, relFile)
  if (!g.hasNode(src)) {
    g.addNode(src, { id: src, type: NodeType.FileNode, name: relFile } as unknown as GraphNode)
  }
  const id = extractedEdgeId(src, dbId, EdgeType.CONNECTS_TO)
  g.addEdgeWithKey(id, src, dbId, {
    id,
    source: src,
    target: dbId,
    type: EdgeType.CONNECTS_TO,
    provenance: Provenance.EXTRACTED,
    confidence: EXTRACTED_CONF,
    evidence: { file: `${serviceName}/${relFile}`, hostSource },
  })
}

// An OBSERVED `service → database` CONNECTS_TO — production really talks to it.
function addObservedConnection(g: NeatGraph, serviceName: string, dbId: string): void {
  const src = serviceId(serviceName)
  const id = observedEdgeId(src, dbId, EdgeType.CONNECTS_TO)
  g.addEdgeWithKey(id, src, dbId, {
    id,
    source: src,
    target: dbId,
    type: EdgeType.CONNECTS_TO,
    provenance: Provenance.OBSERVED,
    confidence: 0.9,
    lastObserved: new Date().toISOString(),
    signal: { spanCount: 200, errorCount: 0, lastObservedAgeMs: 1000 },
  })
}

function missingObservedFor(g: NeatGraph, dbId: string) {
  return computeDivergences(g).divergences.find(
    (d) => d.type === 'missing-observed' && d.target === dbId,
  )
}

describe('dead-code datastore probe dampening (ADR-213, #1072)', () => {
  it('dampens the badhost fault-probe: never-observed literal beside an observed same-engine store', () => {
    const g = baseGraph()
    addService(g, CART)
    // Real store: env-configured, observed.
    const valkey = addDatabase(g, 'valkey-cart', 'redis', 'merged')
    addDeclaredConnection(g, CART, STORE_FILE, valkey, 'config')
    addObservedConnection(g, CART, valkey)
    // Fault-probe: hardcoded literal, never observed.
    const badhost = addDatabase(g, 'badhost', 'redis', 'static')
    addDeclaredConnection(g, CART, STORE_FILE, badhost, 'literal')

    const probe = missingObservedFor(g, badhost)
    expect(probe, 'the badhost divergence still surfaces (dampened, not deleted)').toBeDefined()
    expect(probe!.confidence).toBeLessThanOrEqual(0.1)
    expect(probe!.reason.toLowerCase()).toMatch(/dead-code|fault-injection|flag-gated|probe/)

    // The real store fused (extracted + observed), so it is no divergence at all.
    expect(missingObservedFor(g, valkey)).toBeUndefined()
  })

  it('preserves the real broken dependency: a host that WAS observed then went dark', () => {
    const g = baseGraph()
    addService(g, CART)
    // valkey-cart was observed (discoveredVia 'merged') but its OBSERVED edge is
    // gone — production stopped connecting. Code still declares it: the real
    // "declared, runtime stops making it" divergence.
    const valkey = addDatabase(g, 'valkey-cart', 'redis', 'merged')
    addDeclaredConnection(g, CART, STORE_FILE, valkey, 'config')

    const real = missingObservedFor(g, valkey)
    expect(real, 'the real broken-dependency divergence must fire').toBeDefined()
    expect(real!.confidence).toBe(EXTRACTED_CONF) // full confidence, undampened
    expect(real!.reason.toLowerCase()).not.toMatch(/dead-code|fault-injection|probe/)
  })

  it('gate 2 is load-bearing: a literal host that WAS observed then went dark stays confident even with an observed sibling', () => {
    const g = baseGraph()
    addService(g, CART)
    // An observed same-engine sibling exists...
    const valkey = addDatabase(g, 'valkey-cart', 'redis', 'merged')
    addDeclaredConnection(g, CART, STORE_FILE, valkey, 'config')
    addObservedConnection(g, CART, valkey)
    // ...but this literal host was itself observed once (discoveredVia 'merged')
    // and went dark. It is a real dependency, not a probe.
    const flaky = addDatabase(g, 'flaky-redis', 'redis', 'merged')
    addDeclaredConnection(g, CART, 'cartstore/FlakyStore.cs', flaky, 'literal')

    const d = missingObservedFor(g, flaky)
    expect(d).toBeDefined()
    expect(d!.confidence).toBe(EXTRACTED_CONF)
  })

  it('gate 1 is load-bearing: an env-configured never-observed store with an observed sibling stays confident', () => {
    const g = baseGraph()
    addService(g, CART)
    const valkey = addDatabase(g, 'valkey-cart', 'redis', 'merged')
    addDeclaredConnection(g, CART, STORE_FILE, valkey, 'config')
    addObservedConnection(g, CART, valkey)
    // A second, config-driven redis the deployment declares but production has
    // not exercised in this window — a real never-observed dependency, not a
    // hardcoded probe. Must keep full confidence.
    const replica = addDatabase(g, 'valkey-replica', 'redis', 'static')
    addDeclaredConnection(g, CART, 'cartstore/ReplicaStore.cs', replica, 'config')

    const d = missingObservedFor(g, replica)
    expect(d).toBeDefined()
    expect(d!.confidence).toBe(EXTRACTED_CONF)
  })

  it('gate 3 is load-bearing: an isolated never-observed literal with no observed sibling stays confident', () => {
    const g = baseGraph()
    addService(g, 'solo')
    // The sole declared store, a literal, never observed. There is no observed
    // store standing in for it, so "declared but never driven" is a real finding.
    const lonely = addDatabase(g, 'lonely-db', 'redis', 'static')
    addDeclaredConnection(g, 'solo', STORE_FILE, lonely, 'literal')

    const d = missingObservedFor(g, lonely)
    expect(d).toBeDefined()
    expect(d!.confidence).toBe(EXTRACTED_CONF)
  })

  it('same-engine only: a literal store whose only observed sibling is a different engine stays confident', () => {
    const g = baseGraph()
    addService(g, 'mix')
    // Observed store is postgres...
    const pg = addDatabase(g, 'orders-pg', 'postgresql', 'merged')
    addDeclaredConnection(g, 'mix', 'Db/OrdersContext.cs', pg, 'config')
    addObservedConnection(g, 'mix', pg)
    // ...the never-observed literal is redis: not a dead alternate of the pg store.
    const badredis = addDatabase(g, 'badredis', 'redis', 'static')
    addDeclaredConnection(g, 'mix', STORE_FILE, badredis, 'literal')

    const d = missingObservedFor(g, badredis)
    expect(d).toBeDefined()
    expect(d!.confidence).toBe(EXTRACTED_CONF)
  })
})
