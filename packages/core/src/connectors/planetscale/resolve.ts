// Target resolution — the PlanetScale-specific half of the pull/map/fuse split
// (connectors.md §Authority): turning a signal's (targetKind, targetName) into
// a NEAT node id. A pure lookup against the graph; no mutation authority of its
// own (ADR-030), so the honest fallback is *declared* via `ensureInfraNode`
// (connectors.md §4a, ADR-133) for the shared pipeline to enact.
//
// The fusion target is the `sql-table` node the static SQL/ORM extractor
// already mints (`infraId('sql-table', <table>)`) — the exact id the Neon and
// Supabase table-grain connectors resolve onto, and the id the SQLAlchemy /
// Django / Drizzle / Prisma table extractors build. Landing here means the
// OBSERVED edge sharpens to file grain automatically wherever that node
// carries a real file:line static call site (the shared pipeline's
// staticCallSiteFor), the ADR-124 compounding payoff — no connector-side
// change when the extractor grows.
//
// Honest miss (connectors.md §4a): when no `sql-table` node exists yet — the
// static extractor hasn't run against this code, or doesn't parse the shape —
// the signal must NOT fabricate a table node. Instead it stays honestly at the
// PROVIDER level: a `planetscale-database` InfraNode declared observed-but-
// undeclared, so the traffic surfaces as a `missing-extracted` divergence
// rather than a silent drop. A future PlanetScale schema extractor that mints
// the `sql-table` node makes these edges sharpen onto it with no change here.

import { EdgeType, infraId } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import type { ResolveConnectorTarget, ResolvedConnectorTarget } from '../index.js'
import type { ConnectorContext, ObservedSignal } from '../types.js'
import { PLANETSCALE_SQL_TABLE_TARGET_KIND, type PlanetscaleConnectorConfig } from './types.js'

// The provider-level fallback node's stable identity: the org/database pair the
// connector polls. Never a table — a database (connectors.md §4a's honest
// provider-node fallback, like Cloud Run's `cloud-run-service`).
const PLANETSCALE_DATABASE_KIND = 'planetscale-database'

export function createPlanetscaleResolveTarget(
  graph: NeatGraph,
  config: PlanetscaleConnectorConfig,
): ResolveConnectorTarget {
  const databaseName = `${config.organization}/${config.database}`
  return (signal: ObservedSignal, _ctx: ConnectorContext): ResolvedConnectorTarget | null => {
    if (signal.targetKind !== PLANETSCALE_SQL_TABLE_TARGET_KIND || !signal.targetName) return null

    // Prefer the existing canonical sql-table node the static extractor minted.
    // Landing on it lets the observation fuse onto the file→table static call
    // site for file grain, rather than collapsing to the provider node.
    const tableId = infraId('sql-table', signal.targetName)
    if (graph.hasNode(tableId)) {
      return { targetNodeId: tableId, serviceName: config.serviceName, edgeType: EdgeType.CALLS }
    }

    // No such table node — honest miss. Fall back to the provider-level
    // database node (never a fabricated table), declared for the shared
    // pipeline to ensure (ADR-030 / §4a). `targetNodeId` MUST equal
    // `infraId(kind, name)` when `ensureInfraNode` is set.
    const providerId = infraId(PLANETSCALE_DATABASE_KIND, databaseName)
    return {
      targetNodeId: providerId,
      serviceName: config.serviceName,
      edgeType: EdgeType.CALLS,
      ensureInfraNode: { kind: PLANETSCALE_DATABASE_KIND, name: databaseName, provider: 'planetscale' },
    }
  }
}
