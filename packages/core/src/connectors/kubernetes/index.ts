// The Kubernetes deploy-state connector (ADR-224, #1124) — the second
// incident-emitting connector (connectors.md §10) after EAS.
//
// poll() resolves the cluster transport from the credential (a token +
// apiServerUrl, or a kubeconfig), reads Deployments + Pods in one namespace
// (client.ts), and maps each *unhealthy* workload to an incident-bearing
// ObservedSignal (map.ts): a bad image, zero replicas, a crashloop. Target
// resolution — the workload's service node via the shared fused-service lookup —
// lives in resolve.ts. Everything downstream (writing the incident to the
// ledger) is the shared connectors/index.ts pipeline; this module never touches
// the graph or the ledger directly (ADR-030).
//
// Why this connector exists: a workload down for a deployment reason emits no
// spans (the pod never starts, or is gone), so the graph is blind to it. Pulling
// cluster state turns that blind spot into a first-class OBSERVED incident on the
// service node, fused with the code deps and the observed connection-refused
// edges already there (#1124).

import type { NeatGraph } from '../../graph.js'
import type { ConnectorContext, ObservedConnector, ObservedSignal } from '../types.js'
import type { ResolveConnectorTarget } from '../index.js'
import { fetchDeployments, fetchPods } from './client.js'
import { resolveK8sTransport } from './kubeconfig.js'
import { mapWorkloadsToSignals } from './map.js'
import { createK8sResolveTarget } from './resolve.js'
import { readK8sCredentials, type K8sConnectorConfig } from './types.js'

export * from './client.js'
export * from './kubeconfig.js'
export * from './map.js'
export * from './resolve.js'
export * from './types.js'

export class KubernetesConnector implements ObservedConnector {
  readonly provider = 'kubernetes'

  constructor(
    private readonly config: K8sConnectorConfig,
    // Test seam — a fake `fetch` stands in for the live k8s API so poll() never
    // needs a real cluster. Production leaves it undefined and the client builds
    // the TLS-configured https adapter from the transport.
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async poll(ctx: ConnectorContext): Promise<ObservedSignal[]> {
    const creds = readK8sCredentials(ctx.credentials)
    const transport = resolveK8sTransport(creds, this.config)
    const namespace = this.config.namespace
    const opts = {
      ...(this.config.apiUrl ? { apiUrl: this.config.apiUrl } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    }
    // Two read-only list calls; a deployment fault is a current-state fact, so
    // there is no watermark to honour (unlike the request-log / build connectors)
    // — each poll reads the whole namespace's current state.
    const [deployments, pods] = await Promise.all([
      fetchDeployments(transport, namespace, opts),
      fetchPods(transport, namespace, opts),
    ])
    return mapWorkloadsToSignals(deployments, pods, this.config)
  }
}

/**
 * Wires up a ready-to-register k8s connector: the `ObservedConnector` plus the
 * `resolveTarget` callback the shared pipeline needs alongside it. Both are built
 * together because `resolveTarget` closes over `graph` — the shared scaffold's
 * `ResolveConnectorTarget` signature never receives it directly.
 */
export function createKubernetesConnector(
  graph: NeatGraph,
  config: K8sConnectorConfig,
  fetchImpl?: typeof fetch,
): { connector: ObservedConnector; resolveTarget: ResolveConnectorTarget } {
  return {
    connector: new KubernetesConnector(config, fetchImpl),
    resolveTarget: createK8sResolveTarget(graph),
  }
}
