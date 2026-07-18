// Target resolution — the Supabase-specific half of the pull/map/fuse split
// (connectors.md §Authority): turning a signal's (targetKind, targetName)
// into a NEAT node id.
//
// This is the one place this connector's design departs from Railway/
// Firebase's fusion pattern in a way worth calling out explicitly. Those two
// providers fuse onto a RouteNode a static extractor (routes.ts) already
// builds today. Supabase's own static extractor (extract/calls/supabase.ts)
// recognizes only `createClient(...)` — not `.from()`/`.rpc()` — so the
// table/RPC-grain InfraNode this connector's signals are meant to land on
// (`infraId('supabase-table', ...)` / `infraId('supabase-rpc', ...)`,
// supabase.md §Fusion) never exists in today's graph. `resolveTarget` cannot
// create it either: a provider module has no mutation authority (ADR-030 —
// only ingest.ts and extract/* call a graph mutator directly), and
// `ResolveConnectorTarget`'s own signature only names an id, it never creates
// one (the same constraint railway/connector.ts's own doc comment names for
// its `unmatched-route` case).
//
// So: prefer the table/RPC InfraNode when it exists (the day a follow-up
// extractor cut adds `.from()`/`.rpc()` parsing, this connector's edges
// sharpen to that grain automatically, no connector-side change required —
// exactly ADR-124's "the fusion payoff compounds once a follow-up issue
// extends the extractor to match"); fall back to the project-level InfraNode
// the *current* extractor already mints from a `createClient(...)` call
// (`infraId('supabase', nodeRef)`) when it doesn't — project-level, honestly,
// never fabricated. Neither existing is an honest miss (extraction hasn't run
// against this project's code, or found no `createClient(...)` call to
// resolve `nodeRef` from) — connectors.md §4's "lands service-level (or
// provider-node-level), honestly" applies on the target side here exactly as
// it does on the source side for every other connector's callSite-less case.

import { EdgeType, infraId } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import type { ResolveConnectorTarget, ResolvedConnectorTarget } from '../index.js'
import type { ConnectorContext, ObservedSignal } from '../types.js'
import { SUPABASE_RPC_TARGET_KIND, SUPABASE_TABLE_TARGET_KIND, type SupabaseConnectorConfig } from './types.js'

export function createSupabaseResolveTarget(
  graph: NeatGraph,
  config: SupabaseConnectorConfig,
): ResolveConnectorTarget {
  return (signal: ObservedSignal, _ctx: ConnectorContext): ResolvedConnectorTarget | null => {
    if (signal.targetKind !== SUPABASE_TABLE_TARGET_KIND && signal.targetKind !== SUPABASE_RPC_TARGET_KIND) {
      return null
    }

    const subResourceId = infraId(signal.targetKind, `${config.nodeRef}/${signal.targetName}`)
    if (graph.hasNode(subResourceId)) {
      return { targetNodeId: subResourceId, serviceName: config.serviceName, edgeType: EdgeType.CALLS }
    }

    // #803 — the static extractor mints table/RPC call sites at bare
    // `infra:<kind>:<table>` grain (it parses `<client>.from('table')` but can't
    // know the connector's nodeRef). Prefer that table node when it exists so the
    // observation lands table-grained — and can then fuse onto the file→table
    // static call site for file-grain — rather than collapsing to the project node.
    const bareResourceId = infraId(signal.targetKind, signal.targetName)
    if (graph.hasNode(bareResourceId)) {
      return { targetNodeId: bareResourceId, serviceName: config.serviceName, edgeType: EdgeType.CALLS }
    }

    const projectLevelId = infraId('supabase', config.nodeRef)
    if (graph.hasNode(projectLevelId)) {
      return { targetNodeId: projectLevelId, serviceName: config.serviceName, edgeType: EdgeType.CALLS }
    }

    // Neither node exists yet — extraction hasn't run against this project's
    // code, or found no `createClient(...)` call resolving to this `nodeRef`.
    // Honest miss (connectors.md's "never fabricates a node or edge"),
    // dropped rather than guessed.
    return null
  }
}
