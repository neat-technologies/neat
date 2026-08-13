// Target resolution — the EAS-specific half of the pull/map/fuse split
// (connectors.md §Authority): turning a build failure's `(serviceName,
// buildPhase)` into the NEAT node the incident lands on (ADR-185, connectors.md
// §10). `buildPhase` is a strict enum, so the mapping is deterministic:
//
//   READ_EAS_JSON                            -> eas.json ConfigNode
//   READ_APP_CONFIG / CONFIGURE_EXPO_UPDATES  -> app.json / app.config.json ConfigNode
//     / CALCULATE_EXPO_UPDATES_RUNTIME_VERSION
//   READ_PACKAGE_JSON / INSTALL_DEPENDENCIES  -> the app's ServiceNode
//   everything else (native compile, unknown) -> the app's ServiceNode + logs
//
// A config phase lands on the ConfigNode the extractor mints for that file
// (ADR-185 added JSON build-config extraction), scoped to the emitting service so
// a monorepo doesn't cross-attribute. Everything else lands on the app's
// ServiceNode, resolved through the SAME fused-service lookup the OTLP incident
// path uses (`resolveFusedServiceId`, #988/#992) so a build incident fuses onto
// the extracted service, never a connector twin. The build logs ride in the
// incident's own attributes (map.ts), so the ServiceNode anchor still hands the
// agent what it needs to root-cause a native failure.
//
// This module never mutates the graph (ADR-030) — it reads ConfigNode /
// ServiceNode attributes already there and hands the id back for the shared
// pipeline to write the incident against, matching every other connectors/**
// resolveTarget. When neither a ConfigNode nor an extracted ServiceNode resolves,
// it returns the (possibly not-yet-materialised) service id and the pipeline
// drops the incident honestly rather than fabricating a node.

import { EdgeType, NodeType, parseFileId, type GraphEdge } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { resolveFusedServiceId } from '../../ingest.js'
import type { ResolveConnectorTarget, ResolvedConnectorTarget } from '../index.js'
import { EAS_TARGET_KIND, parseEasTargetName } from './types.js'

// The connectors plane's env-unscoped sentinel (identity.ts's ENV_UNKNOWN) — a
// build failure carries no `deployment.environment`, so it fuses onto the
// env-less `service:<name>` the extractor mints.
const NO_ENV = 'unknown'

// Which config-file basenames a phase implicates. package.json phases are absent
// on purpose — package.json is a ServiceNode, not a ConfigNode (ADR-185), so
// those fall through to the service anchor below.
const EAS_JSON_PHASES = new Set<string>(['READ_EAS_JSON'])
const APP_CONFIG_PHASES = new Set<string>([
  'READ_APP_CONFIG',
  'CONFIGURE_EXPO_UPDATES',
  'CALCULATE_EXPO_UPDATES_RUNTIME_VERSION',
])

function configBasenamesForPhase(phase: string): string[] {
  if (EAS_JSON_PHASES.has(phase)) return ['eas.json']
  if (APP_CONFIG_PHASES.has(phase)) return ['app.json', 'app.config.json']
  return []
}

// The service a ConfigNode belongs to, read off its inbound CONFIGURED_BY edge
// (source `file:<service>:<relPath>`, minted by extract/configs.ts). Null when
// the node has no such edge (it always does when the extractor made it).
function configNodeService(graph: NeatGraph, configNodeId: string): string | null {
  for (const edgeId of graph.inboundEdges(configNodeId)) {
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    if (edge.type !== EdgeType.CONFIGURED_BY) continue
    const parsed = parseFileId(edge.source)
    if (parsed) return parsed.service
  }
  return null
}

// Find the ConfigNode for one of `basenames`, preferring one owned by
// `serviceName` (so a monorepo's other app.json isn't cross-attributed), then
// any with the basename (a single-app repo, or an unmapped connector whose
// serviceName is the app id rather than the package name). Null when the
// extractor minted no such ConfigNode — the caller then falls back to the
// service anchor rather than inventing one.
function findConfigNode(graph: NeatGraph, basenames: string[], serviceName: string): string | null {
  let scoped: string | null = null
  let anyMatch: string | null = null
  graph.forEachNode((id, attrs) => {
    if (scoped) return
    const node = attrs as { type?: string; name?: string }
    if (node.type !== NodeType.ConfigNode) return
    if (typeof node.name !== 'string' || !basenames.includes(node.name)) return
    if (anyMatch === null) anyMatch = id
    if (configNodeService(graph, id) === serviceName) scoped = id
  })
  return scoped ?? anyMatch
}

/**
 * Builds the resolveTarget callback runConnectorPoll (connectors/index.ts) calls
 * once per signal. Closes over `graph` because ResolveConnectorTarget's own
 * signature doesn't carry it — the same closure pattern every connector's
 * resolveTarget uses. `edgeType` is required by ResolvedConnectorTarget but
 * unused on the incident path (the pipeline writes an ErrorEvent, not an edge);
 * it's set to a stable placeholder.
 */
export function createEasResolveTarget(graph: NeatGraph): ResolveConnectorTarget {
  return (signal): ResolvedConnectorTarget | null => {
    if (signal.targetKind !== EAS_TARGET_KIND) return null
    const identity = parseEasTargetName(signal.targetName)
    if (!identity) return null
    const { serviceName, phase } = identity

    // Config/dependency-of-config phase → the ConfigNode the extractor minted for
    // that file, when it exists. The fusion assertion: the incident lands on a
    // node the EXTRACTOR produced for the same repo, not a connector twin.
    const basenames = configBasenamesForPhase(phase)
    if (basenames.length > 0) {
      const configNodeId = findConfigNode(graph, basenames, serviceName)
      if (configNodeId) {
        return { targetNodeId: configNodeId, serviceName, edgeType: EdgeType.CALLS }
      }
      // No ConfigNode for the file (the repo uses app.config.js, say) — fall
      // through to the service anchor rather than dropping the failure.
    }

    // Everything else — package.json phases, native compile, unknown — anchors to
    // the app's ServiceNode through the shared fused-service lookup, so the
    // incident fuses onto the extracted node. The pipeline drops it honestly if
    // this id names no node yet (an unmapped app id, an un-extracted service).
    return {
      targetNodeId: resolveFusedServiceId(graph, serviceName, NO_ENV),
      serviceName,
      edgeType: EdgeType.CALLS,
    }
  }
}
