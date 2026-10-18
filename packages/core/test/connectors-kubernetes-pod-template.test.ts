import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MultiDirectedGraph } from 'graphology'
import { infraId, NodeType, serviceId, type GraphEdge, type GraphNode, type InfraNode, type ServiceNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import { readErrorEvents } from '../src/ingest.js'
import { saveGraphToDisk } from '../src/persist.js'
import { computeGraphDiff, loadSnapshotForDiff } from '../src/diff.js'
import {
  PRIORITY_CLASSES_PATH,
  createKubernetesConnector,
  deploymentsPath,
  podTemplateSpec,
  podsPath,
  type Deployment,
  type Pod,
  type PriorityClass,
} from '../src/connectors/kubernetes/index.js'

// #1487 — the pod-template fields a config fault lives in, as observedSpec on the
// workload's k8s-deployment node. Fixtures are the five pass-0 problems where the
// card named a victim because the cause sat in a pod setting. Each mutation is
// the SREGym injector's own (generators/fault/inject_virtual.py, inject_app.py,
// conductor/problems/priority_preemption_cascade.py):
//   init_container_dependency_hang_hotel_reservation — frontend gains init
//     container `wait-for-legacy-config` (busybox:1.28) looping on nslookup of
//     `legacy-config-service`; the pod sits in Init:0/1;
//   wrong_dns_policy_hotel_reservation — profile gets dnsPolicy None, nameserver 8.8.8.8;
//   readiness_probe_misconfiguration_hotel_reservation — frontend gets a readiness
//     probe on /healthz:8080, failureThreshold 1;
//   priority_preemption_cascade_hotel_reservation — PriorityClass `platform-medium`
//     (100000) made the global default, and every peer of reservation moved onto it;
//   revoke_auth_mongodb-1 — admin rights revoked inside MongoDB by a script: no
//     pod-template change at all, the negative control.

const NS = 'test-hotel-reservation'
const KOMPOSE = 'io.kompose.service'
const SERVICES = ['frontend', 'profile', 'search', 'reservation', 'geo', 'mongodb-geo']
const PORTS: Record<string, number> = { frontend: 5000, profile: 8081, search: 8082, reservation: 8087, geo: 8083, 'mongodb-geo': 27017 }

function deployment(name: string): Deployment {
  return {
    metadata: { name, namespace: NS },
    spec: {
      replicas: 1,
      selector: { matchLabels: { [KOMPOSE]: name } },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } },
      template: {
        spec: {
          containers: [
            {
              name: `hotel-reserv-${name}`,
              image: `yinfangchen/hotelreservation:latest`,
              ports: [{ containerPort: PORTS[name]! }],
              resources: { requests: { cpu: '100m' }, limits: { cpu: '1' } },
              env: [{ name: 'JAEGER_SAMPLE_RATIO', value: '1' }],
            },
          ],
        },
      },
    },
    status: { replicas: 1, readyReplicas: 1 },
  }
}
function pod(name: string): Pod {
  return { metadata: { name: `${name}-5b9d7`, namespace: NS, labels: { [KOMPOSE]: name } }, status: { phase: 'Running' } }
}

interface Cluster {
  deployments: Deployment[]
  pods: Pod[]
  priorityClasses: PriorityClass[]
}

function healthy(): Cluster {
  return { deployments: SERVICES.map(deployment), pods: SERVICES.map(pod), priorityClasses: [] }
}

function mutate(c: Cluster, name: string, fn: (d: Deployment) => void): Cluster {
  const deployments = c.deployments.map((d) => {
    if (d.metadata?.name !== name) return d
    const copy = structuredClone(d)
    fn(copy)
    return copy
  })
  return { ...c, deployments }
}

const FAULTS: Record<string, { cluster: () => Cluster; truth: string | null }> = {
  init_container_dependency_hang: {
    truth: infraId('k8s-deployment', 'frontend'),
    cluster: () => {
      const c = mutate(healthy(), 'frontend', (d) => {
        d.spec!.template!.spec!.initContainers = [
          {
            name: 'wait-for-legacy-config',
            image: 'busybox:1.28',
            command: [
              '/bin/sh',
              '-c',
              `echo 'waiting for legacy-config-service to become ready...'; until nslookup legacy-config-service.${NS}.svc.cluster.local >/dev/null 2>&1; do echo 'still waiting on legacy-config-service'; sleep 5; done`,
            ],
          },
        ]
        d.status = { replicas: 1, readyReplicas: 0 }
      })
      c.pods = c.pods.map((p) =>
        p.metadata?.labels?.[KOMPOSE] !== 'frontend'
          ? p
          : {
              ...p,
              status: {
                phase: 'Pending',
                startTime: '2026-10-18T09:40:02Z',
                initContainerStatuses: [
                  { name: 'wait-for-legacy-config', image: 'busybox:1.28', restartCount: 0, state: { running: { startedAt: '2026-10-18T09:40:04Z' } } },
                ],
                containerStatuses: [{ name: 'hotel-reserv-frontend', state: { waiting: { reason: 'PodInitializing' } } }],
              },
            },
      )
      return c
    },
  },
  wrong_dns_policy: {
    truth: infraId('k8s-deployment', 'profile'),
    cluster: () =>
      mutate(healthy(), 'profile', (d) => {
        d.spec!.template!.spec!.dnsPolicy = 'None'
        d.spec!.template!.spec!.dnsConfig = { nameservers: ['8.8.8.8'], searches: [] }
      }),
  },
  readiness_probe_misconfiguration: {
    truth: infraId('k8s-deployment', 'frontend'),
    cluster: () =>
      mutate(healthy(), 'frontend', (d) => {
        d.spec!.template!.spec!.containers![0]!.readinessProbe = {
          httpGet: { path: '/healthz', port: 8080 },
          initialDelaySeconds: 10,
          periodSeconds: 10,
          failureThreshold: 1,
        }
        d.status = { replicas: 1, readyReplicas: 0 }
      }),
  },
  priority_preemption_cascade: {
    truth: infraId('k8s-priorityclass', 'platform-medium'),
    cluster: () => {
      let c = healthy()
      for (const name of SERVICES.filter((s) => s !== 'reservation')) {
        c = mutate(c, name, (d) => {
          d.spec!.template!.spec!.priorityClassName = 'platform-medium'
        })
      }
      c = mutate(c, 'reservation', (d) => {
        d.spec!.template!.spec!.nodeSelector = { 'kubernetes.io/hostname': 'kind-worker2' }
      })
      c.priorityClasses = [
        { metadata: { name: 'platform-medium' }, value: 100000, globalDefault: true, preemptionPolicy: 'PreemptLowerPriority' },
        { metadata: { name: 'production-critical' }, value: 200000, globalDefault: false },
        { metadata: { name: 'system-cluster-critical' }, value: 2000000000, globalDefault: false },
      ]
      return c
    },
  },
  'revoke_auth_mongodb-1': {
    truth: null,
    cluster: () => healthy(),
  },
}

function stubFetch(c: Cluster): typeof fetch {
  const lists: Record<string, unknown[]> = {
    [deploymentsPath(NS)]: c.deployments,
    [podsPath(NS)]: c.pods,
    [PRIORITY_CLASSES_PATH]: c.priorityClasses,
  }
  return (async (url: string | URL) => {
    const items = lists[new URL(String(url)).pathname]
    if (!items) return { ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) } as Response
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ items }) } as Response
  }) as unknown as typeof fetch
}

function newGraph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const name of SERVICES) {
    const node: ServiceNode = { id: serviceId(name), type: NodeType.ServiceNode, name, language: 'go' }
    g.addNode(node.id, node)
  }
  return g
}

async function poll(graph: NeatGraph, c: Cluster, errorsPath?: string) {
  const { connector, resolveTarget } = createKubernetesConnector(graph, { namespace: NS, apiServerUrl: 'https://k8s-pod.test' }, stubFetch(c))
  const ctx: ConnectorContext = { projectDir: '/repo', credentials: { token: 't' }, ...(errorsPath ? { errorsPath } : {}) }
  return runConnectorPoll(connector, ctx, graph, resolveTarget)
}

function spec(graph: NeatGraph, kind: string, name: string): Record<string, unknown> | undefined {
  const id = infraId(kind, name)
  return graph.hasNode(id) ? (graph.getNodeAttributes(id) as InfraNode).observedSpec : undefined
}

// The k8s objects a fault changed against the healthy snapshot.
async function changedObjects(fault: string): Promise<string[]> {
  const graph = newGraph()
  await poll(graph, healthy())
  const snap = path.join(mkdtempSync(path.join(os.tmpdir(), 'neat-k8s-pod-')), 'graph.json')
  await saveGraphToDisk(graph, snap)
  await poll(graph, FAULTS[fault]!.cluster())
  const diff = computeGraphDiff(graph, await loadSnapshotForDiff(snap))
  return [...diff.added.nodes.map((n) => n.id), ...diff.changed.nodes.map((c) => c.id)]
    .filter((id) => id.startsWith('infra:k8s-'))
    .sort()
}

describe('pod-template fields on the k8s-deployment node (#1487)', () => {
  it('reads every field class, and never an env value', () => {
    const d = deployment('frontend')
    const s = d.spec!.template!.spec!
    s.dnsPolicy = 'ClusterFirst'
    s.priorityClassName = 'platform-medium'
    s.nodeSelector = { 'kubernetes.io/hostname': 'kind-worker' }
    s.tolerations = [{ key: 'dedicated', operator: 'Equal', value: 'hotel', effect: 'NoSchedule' }]
    s.affinity = { nodeAffinity: {} }
    s.securityContext = { runAsNonRoot: true }
    s.initContainers = [
      { name: 'migrate', image: 'migrate:1', args: ['--dsn=postgres://app:hunter2@db:5432/app'] },
      // A flag in `command`, its value in `args`: still one argv.
      { name: 'seed', image: 'mysql:8', command: ['mysql', '--password'], args: ['hunter2', '-e', 'select 1'] },
    ]
    const c = s.containers![0]!
    c.env = [
      { name: 'JAEGER_SAMPLE_RATIO', value: '1' },
      { name: 'MONGO_PASSWORD', valueFrom: { secretKeyRef: { name: 'mongo-creds', key: 'password' } } },
      { name: 'GEO_ADDR', valueFrom: { configMapKeyRef: { name: 'hotel-config', key: 'geo' } } },
    ]
    c.envFrom = [{ secretRef: { name: 'hotel-secrets' } }]
    c.livenessProbe = { exec: { command: ['sh', '-c', 'curl -fsS -u admin:hunter2 http://localhost/health'] }, periodSeconds: 5 }
    c.readinessProbe = { exec: { command: ['curl', '-H', 'Authorization: Basic aHVudGVyMg==', 'http://localhost/ready'] } }
    c.securityContext = { readOnlyRootFilesystem: true }

    const out = podTemplateSpec(d)
    expect(out).toMatchObject({
      strategy: { type: 'RollingUpdate' },
      dnsPolicy: 'ClusterFirst',
      priorityClassName: 'platform-medium',
      nodeSelector: { 'kubernetes.io/hostname': 'kind-worker' },
      tolerations: [{ key: 'dedicated' }],
      affinity: { nodeAffinity: {} },
      securityContext: { runAsNonRoot: true },
      initContainers: [
        { name: 'migrate', image: 'migrate:1' },
        { name: 'seed', command: ['mysql', '--password'], args: ['***REDACTED***', '-e', 'select 1'] },
      ],
      containers: [
        {
          name: 'hotel-reserv-frontend',
          resources: { requests: { cpu: '100m' } },
          securityContext: { readOnlyRootFilesystem: true },
          env: [
            { name: 'JAEGER_SAMPLE_RATIO' },
            { name: 'MONGO_PASSWORD', secret: 'mongo-creds', key: 'password' },
            { name: 'GEO_ADDR', configMap: 'hotel-config', key: 'geo' },
          ],
          envFrom: [{ secret: 'hotel-secrets' }],
          livenessProbe: { periodSeconds: 5 },
        },
      ],
    })
    const text = JSON.stringify(out)
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('aHVudGVyMg==')
    expect(text).not.toContain('"value":"1"')
  })

  it('names the init container a pod is stuck on, instead of no-ready-replicas', async () => {
    const graph = newGraph()
    const errorsPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'neat-k8s-init-')), 'errors.ndjson')
    await poll(graph, FAULTS['init_container_dependency_hang']!.cluster(), errorsPath)
    const [event] = await readErrorEvents(errorsPath)
    expect(event?.affectedNode).toBe(serviceId('frontend'))
    expect(event?.errorMessage).toBe(
      'Deployment frontend is stuck initializing: init container wait-for-legacy-config (busybox:1.28) is running',
    )
    const node = graph.getNodeAttributes(serviceId('frontend')) as ServiceNode & { observedDeployContext?: { fault?: string } }
    expect(node.observedDeployContext?.fault).toBe('init-blocked')
    const init = (spec(graph, 'k8s-deployment', 'frontend')?.['initContainers'] as Array<Record<string, unknown>>)[0]
    expect(init?.['command']).toEqual(expect.arrayContaining([expect.stringContaining('legacy-config-service')]))
  })

  it('keeps the PriorityClasses the workloads run under, and a global default', async () => {
    const graph = newGraph()
    await poll(graph, FAULTS['priority_preemption_cascade']!.cluster())
    expect(spec(graph, 'k8s-priorityclass', 'platform-medium')).toEqual({
      globalDefault: true,
      usedByWorkloads: ['frontend', 'geo', 'mongodb-geo', 'profile', 'search'],
      value: 100000,
      preemptionPolicy: 'PreemptLowerPriority',
    })
    // Named by no workload here and not a default.
    expect(spec(graph, 'k8s-priorityclass', 'production-critical')).toBeUndefined()
    expect(spec(graph, 'k8s-priorityclass', 'system-cluster-critical')).toBeUndefined()
  })
})

describe('the five victim-named pass-0 faults against a healthy snapshot (#1487)', () => {
  // What the diff holds per fault. The ground-truth object is in the diff for the
  // four pod-setting faults. revoke_auth changes nothing a pod spec carries.
  it.each([
    ['init_container_dependency_hang', [infraId('k8s-deployment', 'frontend')]],
    ['wrong_dns_policy', [infraId('k8s-deployment', 'profile')]],
    ['readiness_probe_misconfiguration', [infraId('k8s-deployment', 'frontend')]],
    [
      'priority_preemption_cascade',
      [
        ...['frontend', 'geo', 'mongodb-geo', 'profile', 'reservation', 'search'].map((n) => infraId('k8s-deployment', n)),
        infraId('k8s-priorityclass', 'platform-medium'),
      ].sort(),
    ],
    ['revoke_auth_mongodb-1', []],
  ])('%s', async (fault, expected) => {
    const changed = await changedObjects(fault)
    expect(changed).toEqual(expected)
    const truth = FAULTS[fault]!.truth
    if (truth) expect(changed).toContain(truth)
  })
})
