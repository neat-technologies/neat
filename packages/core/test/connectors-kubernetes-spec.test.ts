import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MultiDirectedGraph } from 'graphology'
import { infraId, NodeType, type GraphEdge, type GraphNode, type InfraNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import { saveGraphToDisk } from '../src/persist.js'
import { computeGraphDiff, loadSnapshotForDiff } from '../src/diff.js'
import {
  createKubernetesConnector,
  deploymentsPath,
  podsPath,
  servicesPath,
  type Deployment,
  type Pod,
  type Service,
} from '../src/connectors/kubernetes/index.js'

// #1481 part 3 — the k8s substrate keeps each Service's spec and each workload's
// container ports on their InfraNodes as `observedSpec`, so a spec change against
// a healthy snapshot shows in the graph diff. Fixtures are the two SREGym faults
// that live in a Service (sregym/conductor/problems/):
//   internal_traffic_policy_local — astronomy-shop `recommendation` patched to
//     `internalTrafficPolicy: Local`;
//   service_wrong_pod_selection_hotel_reservation — `frontend`'s selector
//     broadened to `service-route=frontend`, a label the `search` pods carry too
//     (search listens on 8082, frontend's targetPort is 5000).

interface Lists {
  deployments: Deployment[]
  pods: Pod[]
  // Absent: the Services read fails.
  services?: Service[]
}

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}

function stubFetch(lists: Lists, ns: string): typeof fetch {
  return (async (url: string | URL) => {
    const p = new URL(String(url)).pathname
    const items =
      p === deploymentsPath(ns) ? lists.deployments : p === podsPath(ns) ? lists.pods : p === servicesPath(ns) ? lists.services : undefined
    if (items === undefined) return { ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) } as Response
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ items }) } as Response
  }) as unknown as typeof fetch
}

async function poll(graph: NeatGraph, ns: string, lists: Lists) {
  const { connector, resolveTarget } = createKubernetesConnector(
    graph,
    { namespace: ns, apiServerUrl: 'https://k8s.test' },
    stubFetch(lists, ns),
  )
  const ctx: ConnectorContext = { projectDir: '/repo', credentials: { token: 't' } }
  return runConnectorPoll(connector, ctx, graph, resolveTarget)
}

function spec(graph: NeatGraph, kind: string, name: string): Record<string, unknown> | undefined {
  const id = infraId(kind, name)
  return graph.hasNode(id) ? (graph.getNodeAttributes(id) as InfraNode).observedSpec : undefined
}

// ── astronomy-shop: internalTrafficPolicy: Local ────────────────────────────

const ASTRO = 'astronomy-shop'
const NAME = 'opentelemetry.io/name'

function astroDeployment(name: string, port: number): Deployment {
  return {
    metadata: { name, namespace: ASTRO },
    spec: {
      replicas: 1,
      selector: { matchLabels: { [NAME]: name } },
      template: { spec: { containers: [{ name, ports: [{ containerPort: port, name: 'service', protocol: 'TCP' }] }] } },
    },
    status: { replicas: 1, readyReplicas: 1 },
  }
}
function astroPod(name: string): Pod {
  return { metadata: { name: `${name}-6d4f8`, namespace: ASTRO, labels: { [NAME]: name } }, status: { phase: 'Running' } }
}
function recommendationService(policy: 'Cluster' | 'Local'): Service {
  return {
    metadata: { name: 'recommendation', namespace: ASTRO },
    spec: {
      type: 'ClusterIP',
      clusterIP: '10.96.88.14',
      clusterIPs: ['10.96.88.14'],
      internalTrafficPolicy: policy,
      selector: { [NAME]: 'recommendation' },
      ports: [{ name: 'tcp-service', port: 8080, protocol: 'TCP', targetPort: 8080 }],
    },
  }
}
function astro(policy: 'Cluster' | 'Local'): Lists {
  return {
    deployments: [astroDeployment('recommendation', 8080), astroDeployment('frontend', 8080)],
    pods: [astroPod('recommendation'), astroPod('frontend')],
    services: [recommendationService(policy)],
  }
}

describe('k8s Service spec on the k8s-service node (#1481)', () => {
  it('keeps type, traffic policy, selector, ports and the workload it selects', async () => {
    const graph = newGraph()
    await poll(graph, ASTRO, astro('Local'))
    const node = graph.getNodeAttributes(infraId('k8s-service', 'recommendation')) as InfraNode
    expect(node.type).toBe(NodeType.InfraNode)
    expect(node.provider).toBe('kubernetes')
    expect(node.namespace).toBe(ASTRO)
    // ADR-270 adds `operational` and `specHash` beside these fields.
    expect(node.observedSpec).toMatchObject({
      type: 'ClusterIP',
      internalTrafficPolicy: 'Local',
      selector: { [NAME]: 'recommendation' },
      selectsWorkloads: ['recommendation'],
      selectorAmbiguous: false,
      ports: [{ name: 'tcp-service', protocol: 'TCP', port: 8080, targetPort: 8080 }],
    })
    expect(spec(graph, 'k8s-deployment', 'recommendation')).toMatchObject({
      containerPorts: [{ port: 8080, container: 'recommendation', name: 'service', protocol: 'TCP' }],
    })
  })

  it('shows the policy patch in the diff against a healthy snapshot', async () => {
    const graph = newGraph()
    await poll(graph, ASTRO, astro('Cluster'))
    const healthy = path.join(mkdtempSync(path.join(os.tmpdir(), 'neat-k8s-spec-')), 'graph.json')
    await saveGraphToDisk(graph, healthy)

    await poll(graph, ASTRO, astro('Local'))
    const diff = computeGraphDiff(graph, await loadSnapshotForDiff(healthy))
    expect(diff.changed.nodes.map((c) => c.id)).toEqual([infraId('k8s-service', 'recommendation')])
    const c = diff.changed.nodes[0]!
    expect((c.before as InfraNode).observedSpec?.['internalTrafficPolicy']).toBe('Cluster')
    expect((c.after as InfraNode).observedSpec?.['internalTrafficPolicy']).toBe('Local')
  })

  it('leaves the spec as it was when the Services read fails', async () => {
    const graph = newGraph()
    await poll(graph, ASTRO, astro('Local'))
    await poll(graph, ASTRO, { ...astro('Cluster'), services: undefined })
    expect(spec(graph, 'k8s-service', 'recommendation')?.['internalTrafficPolicy']).toBe('Local')
  })
})

// ── hotel-reservation: a selector covering two workloads ─────────────────────

const HOTEL = 'hotel-reservation'
const KOMPOSE = 'io.kompose.service'

function hotelDeployment(name: string, port: number): Deployment {
  return {
    metadata: { name, namespace: HOTEL },
    spec: {
      replicas: 1,
      selector: { matchLabels: { [KOMPOSE]: name } },
      template: { spec: { containers: [{ name: `hotel-reserv-${name}`, ports: [{ containerPort: port }] }] } },
    },
    status: { replicas: 1, readyReplicas: 1 },
  }
}
function hotelPod(name: string): Pod {
  return {
    metadata: { name: `${name}-5c7b9`, namespace: HOTEL, labels: { [KOMPOSE]: name, 'service-route': 'frontend' } },
    status: { phase: 'Running' },
  }
}

describe('a Service selector that covers more than one workload (#1484)', () => {
  it('flags the frontend Service and keeps both workloads it reaches', async () => {
    const graph = newGraph()
    await poll(graph, HOTEL, {
      deployments: [hotelDeployment('frontend', 5000), hotelDeployment('search', 8082)],
      pods: [hotelPod('frontend'), hotelPod('search')],
      services: [
        {
          metadata: { name: 'frontend', namespace: HOTEL },
          spec: {
            clusterIP: '10.96.40.2',
            selector: { 'service-route': 'frontend' },
            ports: [{ name: '5000', port: 5000, targetPort: 5000 }],
          },
        },
      ],
    })
    const s = spec(graph, 'k8s-service', 'frontend')
    expect(s?.['selectsWorkloads']).toEqual(['frontend', 'search'])
    expect(s?.['selectorAmbiguous']).toBe(true)
    expect(spec(graph, 'k8s-deployment', 'search')).toMatchObject({
      containerPorts: [{ port: 8082, container: 'hotel-reserv-search' }],
    })
  })
})
