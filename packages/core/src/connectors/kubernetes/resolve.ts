// Target resolution — the k8s-specific half of the pull/map/fuse split
// (connectors.md §Authority): turning an unhealthy workload's `serviceName` into
// the NEAT node the incident lands on (ADR-224, connectors.md §10). A deployment
// fault belongs to the whole service (the image, the replica count, the crash are
// service-wide, not route- or file-scoped), so it anchors on the app's
// ServiceNode — resolved through the SAME fused-service lookup the OTLP incident
// path uses (`resolveFusedServiceId`, #988/#992) so the incident fuses onto the
// extracted service the code deps and observed connection-refused edges already
// hang off, never a connector-minted twin.
//
// This module never mutates the graph (ADR-030) — it hands back the resolved id
// for the shared pipeline to write the incident against. When the service names
// no node yet (an unmapped deployment name, an un-extracted service), the
// pipeline drops the incident honestly rather than fabricating a node — the same
// missing-target discipline EAS's resolver holds.

import { EdgeType } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { resolveFusedServiceId } from '../../ingest.js'
import type { ResolveConnectorTarget, ResolvedConnectorTarget } from '../index.js'
import { K8S_TARGET_KIND, parseK8sTargetName } from './types.js'

// The connectors plane's env-unscoped sentinel (identity.ts's ENV_UNKNOWN) — a
// deployment fault carries no `deployment.environment`, so it fuses onto the
// env-less `service:<name>` the extractor mints.
const NO_ENV = 'unknown'

/**
 * Builds the resolveTarget callback runConnectorPoll (connectors/index.ts) calls
 * once per signal. Closes over `graph` because ResolveConnectorTarget's own
 * signature doesn't carry it — the same closure pattern every connector's
 * resolveTarget uses. `edgeType` is required by ResolvedConnectorTarget but
 * unused on the incident path (the pipeline writes an ErrorEvent, not an edge);
 * it's set to a stable placeholder, as EAS's resolver does.
 */
export function createK8sResolveTarget(graph: NeatGraph): ResolveConnectorTarget {
  return (signal): ResolvedConnectorTarget | null => {
    if (signal.targetKind !== K8S_TARGET_KIND) return null
    const identity = parseK8sTargetName(signal.targetName)
    if (!identity) return null
    const { serviceName } = identity
    return {
      targetNodeId: resolveFusedServiceId(graph, serviceName, NO_ENV),
      serviceName,
      edgeType: EdgeType.CALLS,
    }
  }
}
