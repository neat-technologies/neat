import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MultiDirectedGraph } from 'graphology'
import { infraId, type GraphEdge, type GraphNode, type InfraNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import { saveGraphToDisk } from '../src/persist.js'
import { computeGraphDiff, loadSnapshotForDiff } from '../src/diff.js'
import {
  CLUSTER_ROLE_BINDINGS_PATH,
  CLUSTER_ROLES_PATH,
  COREDNS_CONFIGMAP_PATH,
  MUTATING_WEBHOOKS_PATH,
  createKubernetesConnector,
  deploymentsPath,
  namespacePath,
  networkPoliciesPath,
  podsPath,
  resourceQuotasPath,
  roleBindingsPath,
  rolesPath,
  selectorMatches,
  servicesPath,
  type ConfigMap,
  type Deployment,
  type MutatingWebhookConfiguration,
  type NetworkPolicy,
  type Pod,
  type ResourceQuota,
  type Role,
  type RoleBinding,
} from '../src/connectors/kubernetes/index.js'

// #1484 parts 3-4 — the objects a config fault lives in when no pod carries it,
// as InfraNodes with their live spec. Fixtures are SREGym's
// (sregym/conductor/problems/, generators/fault/inject_virtual.py):
//   network_policy_block — `deny-all-recommendation`, podSelector
//     io.kompose.service=recommendation, Ingress+Egress, no rules;
//   namespace_memory_limit — ResourceQuota `memory-limit-quota`;
//   mutating_webhook_resource_limits — `gatekeeper-mutating-webhook-configuration`
//     (webhook `mutation.gatekeeper.sh`) beside decoys;
//   finalizer_deadlock_controller — ClusterRole `configmap-cleanup-controller`
//     bound to ServiceAccount `cleanup-controller`, losing `patch` on configmaps;
//   service_dns_resolution_failure — an NXDOMAIN template in the coredns Corefile.
// The healthy Corefile is the bench cluster's.

const NS = 'hotel-reservation'
const KOMPOSE = 'io.kompose.service'

const HEALTHY_COREFILE = `.:53 {
    errors
    health {
       lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
       ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf {
       max_concurrent 1000
    }
    cache 30 {
       disable success cluster.local
       disable denial cluster.local
    }
    loop
    reload
    loadbalance
}
`
const FQDN = 'user-service.social-network.svc.cluster.local'
const FAULTED_COREFILE = HEALTHY_COREFILE.replace(
  '    kubernetes cluster.local',
  `    template ANY ANY ${FQDN} {\n        match "^${FQDN}\\.$"\n        rcode NXDOMAIN\n        fallthrough\n    }\n    kubernetes cluster.local`,
)

function deployment(name: string, serviceAccountName?: string): Deployment {
  return {
    metadata: { name, namespace: NS },
    spec: {
      replicas: 1,
      selector: { matchLabels: { [KOMPOSE]: name } },
      template: { spec: { containers: [{ name: `hotel-reserv-${name}` }], ...(serviceAccountName ? { serviceAccountName } : {}) } },
    },
    status: { replicas: 1, readyReplicas: 1 },
  }
}
function pod(name: string): Pod {
  return { metadata: { name: `${name}-7f9c`, namespace: NS, labels: { [KOMPOSE]: name } }, status: { phase: 'Running' } }
}

const denyAll: NetworkPolicy = {
  metadata: { name: 'deny-all-recommendation', namespace: NS },
  spec: { podSelector: { matchLabels: { [KOMPOSE]: 'recommendation' } }, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] },
}
const quota: ResourceQuota = {
  metadata: { name: 'memory-limit-quota', namespace: NS },
  spec: { hard: { memory: '1Gi', 'requests.memory': '1Gi', 'limits.memory': '1Gi' } },
  status: { hard: { memory: '1Gi', 'requests.memory': '1Gi', 'limits.memory': '1Gi' }, used: { 'limits.memory': '0' } },
}
function webhookConfig(name: string, webhook: string, namespaces: string[]): MutatingWebhookConfiguration {
  return {
    metadata: { name },
    webhooks: [
      {
        name: webhook,
        failurePolicy: 'Ignore',
        sideEffects: 'None',
        namespaceSelector: { matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'In', values: namespaces }] },
        rules: [{ apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE'], resources: ['pods'], scope: 'Namespaced' }],
        clientConfig: { service: { namespace: 'platform-ops', name: 'platform-policy-controller', path: '/mutate' }, caBundle: 'LS0tLS1CRUdJTi...' },
      },
    ],
  }
}
function cleanupRole(verbs: string[]): Role {
  return { metadata: { name: 'configmap-cleanup-controller' }, rules: [{ apiGroups: [''], resources: ['configmaps'], verbs }] }
}
const cleanupBinding: RoleBinding = {
  metadata: { name: 'configmap-cleanup-controller' },
  roleRef: { kind: 'ClusterRole', name: 'configmap-cleanup-controller', apiGroup: 'rbac.authorization.k8s.io' },
  subjects: [{ kind: 'ServiceAccount', name: 'cleanup-controller', namespace: NS }],
}
// A system binding that names no service account in the namespace.
const systemBinding: RoleBinding = {
  metadata: { name: 'system:kube-scheduler' },
  roleRef: { kind: 'ClusterRole', name: 'system:kube-scheduler' },
  subjects: [{ kind: 'User', name: 'system:kube-scheduler' }],
}

interface Cluster {
  networkPolicies?: NetworkPolicy[]
  resourceQuotas?: ResourceQuota[]
  mutatingWebhooks?: MutatingWebhookConfiguration[]
  roles?: Role[]
  roleBindings?: RoleBinding[]
  clusterRoles?: Role[]
  clusterRoleBindings?: RoleBinding[]
  corefile?: string
}

function healthy(): Cluster {
  return {
    networkPolicies: [],
    resourceQuotas: [],
    mutatingWebhooks: [webhookConfig('cert-manager-webhook', 'webhook.cert-manager.io', ['cert-manager'])],
    roles: [],
    roleBindings: [],
    clusterRoles: [cleanupRole(['get', 'list', 'watch', 'patch']), { metadata: { name: 'system:kube-scheduler' }, rules: [] }],
    clusterRoleBindings: [cleanupBinding, systemBinding],
    corefile: HEALTHY_COREFILE,
  }
}

function stubFetch(c: Cluster): typeof fetch {
  const lists: Record<string, unknown[] | undefined> = {
    [deploymentsPath(NS)]: [deployment('recommendation'), deployment('cleanup-controller', 'cleanup-controller'), deployment('search')],
    [podsPath(NS)]: [pod('recommendation'), pod('cleanup-controller'), pod('search')],
    [servicesPath(NS)]: [],
    [networkPoliciesPath(NS)]: c.networkPolicies,
    [resourceQuotasPath(NS)]: c.resourceQuotas,
    [MUTATING_WEBHOOKS_PATH]: c.mutatingWebhooks,
    [rolesPath(NS)]: c.roles,
    [roleBindingsPath(NS)]: c.roleBindings,
    [CLUSTER_ROLES_PATH]: c.clusterRoles,
    [CLUSTER_ROLE_BINDINGS_PATH]: c.clusterRoleBindings,
  }
  const objects: Record<string, unknown> = {
    [namespacePath(NS)]: { metadata: { name: NS, labels: { 'kubernetes.io/metadata.name': NS } } },
    ...(c.corefile !== undefined
      ? { [COREDNS_CONFIGMAP_PATH]: { metadata: { name: 'coredns', namespace: 'kube-system' }, data: { Corefile: c.corefile } } satisfies ConfigMap }
      : {}),
  }
  return (async (url: string | URL) => {
    const p = new URL(String(url)).pathname
    const forbidden = { ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) } as Response
    if (p in objects) return { ok: true, status: 200, statusText: 'OK', json: async () => objects[p] } as Response
    const items = lists[p]
    if (items === undefined) return forbidden
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ items }) } as Response
  }) as unknown as typeof fetch
}

async function poll(graph: NeatGraph, c: Cluster) {
  const { connector, resolveTarget } = createKubernetesConnector(graph, { namespace: NS, apiServerUrl: 'https://k8s.test' }, stubFetch(c))
  const ctx: ConnectorContext = { projectDir: '/repo', credentials: { token: 't' } }
  return runConnectorPoll(connector, ctx, graph, resolveTarget)
}

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}

function node(graph: NeatGraph, kind: string, name: string): InfraNode | undefined {
  const id = infraId(kind, name)
  return graph.hasNode(id) ? (graph.getNodeAttributes(id) as InfraNode) : undefined
}

describe('k8s config objects as InfraNodes (#1484)', () => {
  it('keeps a deny-all NetworkPolicy with the workload it covers', async () => {
    const graph = newGraph()
    await poll(graph, { ...healthy(), networkPolicies: [denyAll] })
    const np = node(graph, 'k8s-networkpolicy', 'deny-all-recommendation')
    expect(np?.provider).toBe('kubernetes')
    expect(np?.namespace).toBe(NS)
    expect(np?.observedSpec).toEqual({
      podSelector: { matchLabels: { [KOMPOSE]: 'recommendation' } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [],
      selectsWorkloads: ['recommendation'],
    })
  })

  it('keeps a ResourceQuota with its hard limits and use', async () => {
    const graph = newGraph()
    await poll(graph, { ...healthy(), resourceQuotas: [quota] })
    expect(node(graph, 'k8s-resourcequota', 'memory-limit-quota')?.observedSpec).toEqual({
      hard: { memory: '1Gi', 'requests.memory': '1Gi', 'limits.memory': '1Gi' },
      used: { 'limits.memory': '0' },
    })
  })

  it('keeps only the webhook configurations whose namespaceSelector takes the namespace in', async () => {
    const graph = newGraph()
    await poll(graph, {
      ...healthy(),
      mutatingWebhooks: [
        webhookConfig('gatekeeper-mutating-webhook-configuration', 'mutation.gatekeeper.sh', [NS]),
        webhookConfig('cert-manager-webhook', 'webhook.cert-manager.io', ['cert-manager']),
      ],
    })
    expect(node(graph, 'k8s-mutatingwebhookconfiguration', 'cert-manager-webhook')).toBeUndefined()
    const mwc = node(graph, 'k8s-mutatingwebhookconfiguration', 'gatekeeper-mutating-webhook-configuration')
    expect(mwc?.namespace).toBeUndefined()
    const [w] = mwc?.observedSpec?.['webhooks'] as Array<Record<string, unknown>>
    expect(w).toMatchObject({
      name: 'mutation.gatekeeper.sh',
      failurePolicy: 'Ignore',
      service: { namespace: 'platform-ops', name: 'platform-policy-controller', path: '/mutate' },
    })
    expect(JSON.stringify(w)).not.toContain('caBundle')
  })

  it('keeps the ClusterRole bound to a namespace service account, and the workload that runs as it', async () => {
    const graph = newGraph()
    await poll(graph, healthy())
    expect(node(graph, 'k8s-clusterrolebinding', 'configmap-cleanup-controller')?.observedSpec).toEqual({
      roleRef: { kind: 'ClusterRole', name: 'configmap-cleanup-controller', apiGroup: 'rbac.authorization.k8s.io' },
      subjects: [{ kind: 'ServiceAccount', name: 'cleanup-controller', namespace: NS }],
    })
    expect(node(graph, 'k8s-clusterrole', 'configmap-cleanup-controller')?.observedSpec).toEqual({
      rules: [{ apiGroups: [''], resources: ['configmaps'], verbs: ['get', 'list', 'watch', 'patch'] }],
      boundServiceAccounts: ['cleanup-controller'],
    })
    // Nothing bound in the namespace: not read in.
    expect(node(graph, 'k8s-clusterrolebinding', 'system:kube-scheduler')).toBeUndefined()
    expect(node(graph, 'k8s-clusterrole', 'system:kube-scheduler')).toBeUndefined()
    expect(node(graph, 'k8s-deployment', 'cleanup-controller')?.observedSpec?.['serviceAccountName']).toBe('cleanup-controller')
  })

  it('keeps the CoreDNS Corefile', async () => {
    const graph = newGraph()
    await poll(graph, healthy())
    const cm = node(graph, 'k8s-configmap', 'coredns')
    expect(cm?.namespace).toBe('kube-system')
    expect(cm?.observedSpec).toEqual({ corefile: HEALTHY_COREFILE })
  })

  it('shows each injected fault in the diff against a healthy snapshot', async () => {
    const graph = newGraph()
    await poll(graph, healthy())
    const snap = path.join(mkdtempSync(path.join(os.tmpdir(), 'neat-k8s-objects-')), 'graph.json')
    await saveGraphToDisk(graph, snap)

    await poll(graph, {
      ...healthy(),
      networkPolicies: [denyAll],
      resourceQuotas: [quota],
      mutatingWebhooks: [
        webhookConfig('gatekeeper-mutating-webhook-configuration', 'mutation.gatekeeper.sh', [NS]),
        webhookConfig('cert-manager-webhook', 'webhook.cert-manager.io', ['cert-manager']),
      ],
      clusterRoles: [cleanupRole(['get', 'list', 'watch'])],
      corefile: FAULTED_COREFILE,
    })
    const diff = computeGraphDiff(graph, await loadSnapshotForDiff(snap))
    expect(diff.added.nodes.map((n) => n.id).sort()).toEqual([
      infraId('k8s-mutatingwebhookconfiguration', 'gatekeeper-mutating-webhook-configuration'),
      infraId('k8s-networkpolicy', 'deny-all-recommendation'),
      infraId('k8s-resourcequota', 'memory-limit-quota'),
    ])
    expect(diff.changed.nodes.map((c) => c.id).sort()).toEqual([
      infraId('k8s-clusterrole', 'configmap-cleanup-controller'),
      infraId('k8s-configmap', 'coredns'),
    ])
    const dns = diff.changed.nodes.find((c) => c.id === infraId('k8s-configmap', 'coredns'))!
    expect(String((dns.after as InfraNode).observedSpec?.['corefile'])).toContain('rcode NXDOMAIN')
  })

  it('clears the spec off an object that is gone, and leaves a kind it could not read', async () => {
    const graph = newGraph()
    await poll(graph, { ...healthy(), networkPolicies: [denyAll], resourceQuotas: [quota] })
    await poll(graph, { ...healthy(), networkPolicies: [], resourceQuotas: undefined })
    expect(node(graph, 'k8s-networkpolicy', 'deny-all-recommendation')?.observedSpec).toBeUndefined()
    expect(node(graph, 'k8s-resourcequota', 'memory-limit-quota')?.observedSpec).toBeDefined()
  })

  it('still polls when every config read is forbidden', async () => {
    const graph = newGraph()
    const result = await poll(graph, {})
    expect(result.signalCount).toBeGreaterThan(0)
    expect(node(graph, 'k8s-networkpolicy', 'deny-all-recommendation')).toBeUndefined()
    expect(node(graph, 'k8s-deployment', 'recommendation')).toBeDefined()
  })
})

describe('selectorMatches', () => {
  it('reads matchLabels and every matchExpressions operator', () => {
    const labels = { app: 'search', tier: 'backend' }
    expect(selectorMatches({}, labels)).toBe(true)
    expect(selectorMatches({ matchLabels: { app: 'search' } }, labels)).toBe(true)
    expect(selectorMatches({ matchLabels: { app: 'geo' } }, labels)).toBe(false)
    expect(selectorMatches({ matchExpressions: [{ key: 'tier', operator: 'In', values: ['backend'] }] }, labels)).toBe(true)
    expect(selectorMatches({ matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['backend'] }] }, labels)).toBe(false)
    expect(selectorMatches({ matchExpressions: [{ key: 'zone', operator: 'Exists' }] }, labels)).toBe(false)
    expect(selectorMatches({ matchExpressions: [{ key: 'zone', operator: 'DoesNotExist' }] }, labels)).toBe(true)
    expect(selectorMatches({ matchExpressions: [{ key: 'tier', operator: 'Gt' }] }, labels)).toBe(false)
  })
})
