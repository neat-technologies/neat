import type {
  InfraNode,
} from '@neat.is/types'
import {
  NodeType,
  Provenance,
  type ProvenanceValue,
} from '@neat.is/types'
import { foldColumns, OBSERVED_COLUMN_CONFIDENCE } from '../columns.js'
import type { NeatGraph } from '../graph.js'

// Column-grain merges onto table-bearing infra nodes (ADR-157).
// Moved out of ingest.ts; ingest.ts re-exports the public names.

// InfraNode kinds that carry columns — a database table read at column grain
// (ADR-157 §1). `sql-table` is the canonical table node the OTel `db.statement`
// mint and the Neon connector both land on; `supabase-table` is the same table
// grain on the Supabase pull path. A project-level or non-table InfraNode (a
// `supabase` project node, a `mongodb-collection`, a queue/route node) carries no
// columns, so a merge onto one is a no-op.
export const COLUMN_BEARING_INFRA_KINDS = new Set(['sql-table', 'supabase-table'])

// Fold columns onto a table InfraNode at the given provenance (ADR-157 §1-2).
// Columns are provenanced attributes on the table node, never their own nodes. A
// column records each side it has been seen with in its `provenances` set — a
// declared column production also touches ends up `[EXTRACTED, OBSERVED]`, not one
// side clobbering the other — so column drift (ADR-157 §4) can read the declared
// set and the observed set off one node. A no-op for a non-table node or an empty
// column set, so a wildcard / join / DDL statement (which recovers no columns)
// grows nothing. Mutation lives here in ingest.ts per the lifecycle authority
// (ADR-030); the pure fold is columns.ts so extract/* can call it without a cycle.
export function mergeColumnsAt(
  graph: NeatGraph,
  tableNodeId: string,
  columns: readonly string[] | undefined,
  provenance: ProvenanceValue,
  confidence: number,
): void {
  if (!columns || columns.length === 0 || !graph.hasNode(tableNodeId)) return
  const node = graph.getNodeAttributes(tableNodeId) as InfraNode
  if (node.type !== NodeType.InfraNode || !node.kind || !COLUMN_BEARING_INFRA_KINDS.has(node.kind)) {
    return
  }
  graph.replaceNodeAttributes(tableNodeId, {
    ...node,
    columns: foldColumns(node.columns, columns, provenance, confidence),
  })
}

// Merge the columns a production statement touched onto a table InfraNode as
// OBSERVED (ADR-157 §1-2). OTel ingest and the connector mint path both call in.
export function mergeObservedColumns(
  graph: NeatGraph,
  tableNodeId: string,
  columns: readonly string[] | undefined,
): void {
  mergeColumnsAt(graph, tableNodeId, columns, Provenance.OBSERVED, OBSERVED_COLUMN_CONFIDENCE)
}

// Merge the columns a schema/ORM declares onto a table InfraNode as EXTRACTED
// (ADR-157 §3). The declared side of column grain: the static extractor recovers
// each column at database-name fidelity and calls in from extract/calls/*.
export function mergeDeclaredColumns(
  graph: NeatGraph,
  tableNodeId: string,
  columns: readonly string[] | undefined,
  confidence: number,
): void {
  mergeColumnsAt(graph, tableNodeId, columns, Provenance.EXTRACTED, confidence)
}
