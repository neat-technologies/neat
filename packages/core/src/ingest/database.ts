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
import type { SpanIngest } from './context.js'
import { upsertObservedEdge } from './edges.js'
import { ensureInfraNode } from './service.js'
import { mergeObservedColumns } from './table-column.js'
import { pickAddress } from './span.js'

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

// A database span, dispatched from handleSpan when the span carries db.system.
export function ingestDatabaseSpan(s: SpanIngest): string | undefined {
  const {
    ctx,
    span,
    ts,
    sourceId,
    isError,
    durationMs,
    errorDetail,
    callSiteEvidence,
    observedSource,
    mintsFromCallerSide,
  } = s
  if (!span.dbSystem) return undefined
  let affectedNode: string | undefined
  // Database span. A networked database resolves its DatabaseNode by peer
  // host; an in-process / embedded one (SQLite, better-sqlite3, an in-memory
  // store) crosses no network boundary and carries no peer address, so it
  // keys on a service-scoped local identity instead (ADR-118). Both mint the
  // same file-grained service→database CONNECTS_TO OBSERVED edge — the edge
  // that makes a leaf service's datastore reads legible (#576, #546).
  if (mintsFromCallerSide) {
    const host = pickAddress(span)
    // Engine comes off the OTel attribute as a string per Rule 8 — no
    // hardcoded engine list on either branch.
    let targetId: string
    if (host) {
      targetId = ensureDatabaseNode(ctx.graph, host, span.dbSystem)
    } else {
      // No peer host. Prefer fusing onto the service's declared database of
      // the same engine (ADR-141) so an ORM's host-less span confirms the
      // static dependency instead of minting a divergent twin. Falls back to a
      // service-local node (ADR-118) for a genuinely embedded DB (SQLite) or an
      // ambiguous declaration. Name the local node by its logical database
      // (db.name) when the span carries one, the engine otherwise.
      const declared = findDeclaredDatabaseForService(ctx.graph, sourceId, span.dbSystem)
      if (declared) {
        targetId = declared
      } else {
        const localName = span.dbName ?? span.dbSystem
        targetId = ensureLocalDatabaseNode(
          ctx.graph,
          span.service,
          localName,
          span.dbSystem,
        )
      }
    }
    const result = upsertObservedEdge(
      ctx.graph,
      EdgeType.CONNECTS_TO,
      observedSource(),
      targetId,
      ts,
      isError,
      callSiteEvidence,
      durationMs,
      errorDetail,
    )
    if (result) affectedNode = targetId

    // ADR-148 — a mongodb span also names the collection it operated on, one
    // grain finer than the database node above. Mint an additive OBSERVED
    // CALLS edge to `infra:mongodb-collection:<name>` — the same node id the
    // mongoose extractor emits (ensureInfraNode + infraId match calls/index.ts
    // exactly) — so the declared and observed collection edges fuse instead of
    // twinning. The collection is read straight off the span (dbCollection:
    // db.collection.name / db.mongodb.collection), so it is ground truth where
    // the extractor's Mongoose-pluralized derivation is quirk-wrong. Additive:
    // a mongodb span with no collection still mints only the db-grain edge
    // above.
    if (span.dbSystem === 'mongodb' && span.dbCollection) {
      const collectionId = ensureInfraNode(ctx.graph, 'mongodb-collection', span.dbCollection, 'self')
      upsertObservedEdge(
        ctx.graph,
        EdgeType.CALLS,
        observedSource(),
        collectionId,
        ts,
        isError,
        callSiteEvidence,
        durationMs,
        errorDetail,
      )
    }
    // A SQL span's table (ADR-152), recovered from `db.statement` because the
    // SQLAlchemy / dbapi instrumentation carries no table attribute. It mints
    // onto the same `infra:sql-table:<name>` node the SQLAlchemy extractor
    // produces, so the declared and observed table access fuse rather than
    // twin. `db.statement`-derived, so it is ground truth where the extractor's
    // model→table derivation is unresolved; additive to the db-grain edge.
    if (span.dbTable) {
      const tableId = ensureInfraNode(ctx.graph, 'sql-table', span.dbTable, 'self')
      upsertObservedEdge(
        ctx.graph,
        EdgeType.CALLS,
        observedSource(),
        tableId,
        ts,
        isError,
        callSiteEvidence,
        durationMs,
        errorDetail,
      )
      // ADR-157 — the same `db.statement` that named the table also names the
      // columns it touched. Merge them onto the table node as OBSERVED column
      // attributes (parsed in `parseOtlpRequest` via `columnsFromSqlStatement`).
      // A statement that recovers no columns (`SELECT *`, a join/subquery
      // degrade) grows nothing.
      mergeObservedColumns(ctx.graph, tableId, span.dbColumns)
    }
  }
  return affectedNode
}
