import type {
  DatabaseNode,
  GraphEdge,
} from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  databaseId,
  localDatabaseId,
} from '@neat.is/types'
import { canonicalEngine } from '../compat.js'
import type { NeatGraph } from '../graph.js'

// DatabaseNode resolution for database spans (ADR-118, ADR-141, ADR-276).
// Moved out of ingest.ts; ingest.ts re-exports the public names.

// Same shape for unseen db.system + host pairs. Engine comes off the OTel
// attribute as a string per Rule 8 — no hardcoded engine list. compatibleDrivers
// is empty until static extraction merges in the matrix-derived drivers.
// Keyed on (engine, host) (ADR-276), the engine canonicalized through the compat
// matrix so the id equals the one static extraction computes for the same store.
export function ensureDatabaseNode(graph: NeatGraph, host: string, rawEngine: string): string {
  const engine = canonicalEngine(rawEngine)
  const id = databaseId(engine, host)
  if (graph.hasNode(id)) return id
  const node: DatabaseNode = {
    id,
    type: NodeType.DatabaseNode,
    name: host,
    engine,
    engineVersion: 'unknown',
    compatibleDrivers: [],
    host,
    discoveredVia: 'otel',
  }
  graph.addNode(id, node)
  return id
}

// An in-process / embedded database (SQLite, better-sqlite3, an in-memory
// store) crosses no network boundary, so its span carries no peer host to key a
// DatabaseNode on. Key it on a service-scoped local identity instead so two
// services each reading their own `app.db` stay distinct nodes rather than
// collapsing onto one (ADR-118). `name` is the logical database from the span
// (db.name) when present, the engine string otherwise. `host` is intentionally
// omitted — an embedded database has no network host, and evidence is never
// fabricated (file-awareness.md §6); host-mismatch divergence skips a hostless
// DatabaseNode. Returns the node id so the caller can point the CONNECTS_TO edge
// at it. Idempotent — high-volume DB spans upsert, never grow the node set.
export function ensureLocalDatabaseNode(
  graph: NeatGraph,
  serviceName: string,
  name: string,
  engine: string,
): string {
  const id = localDatabaseId(serviceName, name)
  if (graph.hasNode(id)) return id
  const node: DatabaseNode = {
    id,
    type: NodeType.DatabaseNode,
    name,
    engine,
    engineVersion: 'unknown',
    compatibleDrivers: [],
    discoveredVia: 'otel',
  }
  graph.addNode(id, node)
  return id
}

// ADR-141 — an ORM such as Prisma emits a `db.system` span with no peer host
// (its query engine backdates the span off the connection), so a host-less span
// would mint a fresh service-local DatabaseNode and leave the service's
// statically declared database — the one parsed from its connection string / ORM
// schema — with no OBSERVED twin: a false `missing-observed` divergence for a DB
// the service demonstrably hammers. Before minting a local node, fuse onto the
// service's already-declared database of the same engine when there is exactly
// one. Ambiguous (two-plus same-engine declared DBs) or none falls back to the
// ADR-118 service-local node — the fusion never guesses which of several it is.
export function findDeclaredDatabaseForService(
  graph: NeatGraph,
  serviceNodeId: string,
  engine: string,
): string | null {
  if (!graph.hasNode(serviceNodeId)) return null
  // A declared database CONNECTS_TO is file-grained by design — it originates
  // from the config file that named the connection (databases/index.ts,
  // file-awareness §7), not the service node. So scan the service node and every
  // file it CONTAINS for a same-engine EXTRACTED CONNECTS_TO target.
  const sources = [serviceNodeId]
  for (const edgeId of graph.outboundEdges(serviceNodeId)) {
    const e = graph.getEdgeAttributes(edgeId) as GraphEdge
    if (e.type === EdgeType.CONTAINS) sources.push(e.target)
  }
  const matches = new Set<string>()
  for (const src of sources) {
    if (!graph.hasNode(src)) continue
    for (const edgeId of graph.outboundEdges(src)) {
      const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
      if (edge.type !== EdgeType.CONNECTS_TO || edge.provenance !== Provenance.EXTRACTED) continue
      if (!graph.hasNode(edge.target)) continue
      const target = graph.getNodeAttributes(edge.target) as DatabaseNode
      if (target.type !== NodeType.DatabaseNode) continue
      if (canonicalEngine(target.engine) !== canonicalEngine(engine)) continue
      matches.add(edge.target)
    }
  }
  return matches.size === 1 ? [...matches][0]! : null
}
