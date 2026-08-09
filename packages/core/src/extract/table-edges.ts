import type { GraphEdge, InfraNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  infraId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { DiscoveredService } from './shared.js'
import { recordExtractionError } from './errors.js'
import { loadSourceFiles, type TableReference } from './calls/shared.js'
import { drizzleForeignKeys } from './calls/drizzle.js'
import { prismaForeignKeys } from './calls/prisma.js'
import { sqlalchemyForeignKeys } from './calls/sqlalchemy.js'
import { railsSchemaForeignKeys, railsModelForeignKeys } from './calls/activerecord.js'
import { laravelMigrationForeignKeys, laravelModelForeignKeys } from './calls/eloquent.js'

// Foreign-key table→table edges (ADR-161). The data-axis sibling of the symbol
// heritage producer (`symbol-edges.ts`, ADR-158 §3): column grain (ADR-157) gave
// a `infra:sql-table:<name>` node its columns but no edges *between* tables, so
// blast-radius / dependencies / root-cause could not walk the data axis. This
// mints one `infra:sql-table:<child> ──REFERENCES──▶ infra:sql-table:<parent>`
// EXTRACTED edge per resolved foreign key.
//
// The per-ORM readers live beside the columns each already parses — Drizzle's
// `.references(() => users.id)`, Prisma's `@relation(fields:[…], references:[…])`,
// SQLAlchemy's `ForeignKey('users.id')`. Each resolves the parent to the DATABASE
// table name (`infraId('sql-table', name)` — the same node the column/table
// extractors and OTLP already target), reproduced verbatim the ORM's way, so the
// FK lands on the fused table node rather than a code-model twin. A computed or
// cross-file-unresolvable reference is left unclaimed by the reader (it returns
// nothing) — never guessed, the never-fabricate discipline of file-awareness.md
// §6. Every edge grades `structural` EXTRACTED with `evidence.file`/`line` pinned
// to the FK declaration site, so ghost-edge cleanup (`retire.ts`) keys off it like
// any other EXTRACTED edge, and every write is `hasNode` / `hasEdge`-guarded.
//
// Runs after `addCallEdges`, whose column/table read has already minted both
// endpoints' InfraNodes; `ensureTableNode` is a self-contained safety net that
// mints a bare table node (same id, no twin) when a referenced table was named in
// a FK but not otherwise picked up. The reasoning core stays agnostic: REFERENCES
// is a plain edge type the generic graph walk admits with no traversal change
// (ADR-158 §6).

export async function addTableEdges(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    const files = await loadSourceFiles(service.dir)
    const refs: TableReference[] = []
    // Rails model associations (ADR-174) and Laravel Eloquent relations
    // (ADR-178) corroborate the schema literals — a relationship is often
    // declared on both sides. They are collected here and appended AFTER the
    // schema/ORM literals, so when the same child→parent pair appears twice the
    // literal (schema.rb / migration) evidence wins the graph-level dedup.
    const modelRefs: TableReference[] = []

    for (const file of files) {
      try {
        refs.push(...drizzleForeignKeys(file, service.dir))
        refs.push(...sqlalchemyForeignKeys(file, service.dir))
        refs.push(...railsSchemaForeignKeys(file, service.dir))
        refs.push(...laravelMigrationForeignKeys(file, service.dir))
        modelRefs.push(...railsModelForeignKeys(file, service.dir))
        modelRefs.push(...laravelModelForeignKeys(file, service.dir))
      } catch (err) {
        recordExtractionError('foreign-key extraction', file.path, err)
      }
    }
    // Prisma's `schema.prisma` is not a walked source file — read once per service.
    try {
      refs.push(...(await prismaForeignKeys(service.dir)))
    } catch (err) {
      recordExtractionError('prisma foreign-key extraction', service.dir, err)
    }
    refs.push(...modelRefs)

    for (const ref of refs) {
      const childId = infraId('sql-table', ref.childTable)
      const parentId = infraId('sql-table', ref.parentTable)
      // A self-referential FK (a tree's `parent_id`) would be a self-loop; the
      // graph disallows them, and a table referencing itself carries no cross-table
      // blast radius, so it is skipped rather than emitted.
      if (childId === parentId) continue

      nodesAdded += ensureTableNode(graph, childId, ref.childTable)
      nodesAdded += ensureTableNode(graph, parentId, ref.parentTable)

      const edgeId = extractedEdgeId(childId, parentId, EdgeType.REFERENCES)
      if (graph.hasEdge(edgeId)) continue
      const edge: GraphEdge = {
        id: edgeId,
        source: childId,
        target: parentId,
        type: EdgeType.REFERENCES,
        provenance: Provenance.EXTRACTED,
        confidence: confidenceForExtracted('structural'),
        evidence: ref.evidence,
      }
      graph.addEdgeWithKey(edgeId, childId, parentId, edge)
      edgesAdded++
    }
  }

  return { nodesAdded, edgesAdded }
}

// Mint a bare `sql-table` InfraNode if the FK named a table nothing else did.
// Idempotent — same `infra:sql-table:<name>` id the column/table extractors and
// OTLP use, so it fuses onto the existing node and never twins. Returns 1 when a
// node was minted, 0 when it already existed.
function ensureTableNode(graph: NeatGraph, id: string, name: string): number {
  if (graph.hasNode(id)) return 0
  const node: InfraNode = {
    id,
    type: NodeType.InfraNode,
    name,
    provider: 'self',
    kind: 'sql-table',
  }
  graph.addNode(id, node)
  return 1
}
