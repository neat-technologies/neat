import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MultiDirectedGraph } from 'graphology'
import { NodeType, serviceId, type GraphEdge, type GraphNode, type ServiceNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import { readErrorEvents } from '../src/ingest.js'
import {
  blockingObject,
  classifyDeployment,
  createKubernetesConnector,
  deploymentsPath,
  eventsPath,
  podsPath,
  replicaSetsPath,
  type Deployment,
  type K8sEvent,
  type Pod,
  type ReplicaSet,
} from '../src/connectors/kubernetes/index.js'

// #1484 part 1 — a pod that admission rejects never exists, so a quota, a webhook
// or a missing service account showed only as `no-ready-replicas`. The reason is
// on the ReplicaSet's ReplicaFailure condition and its FailedCreate event. The
// quota fixture is SREGym's namespace_memory_limit (hotel-reservation `search`
// recreated under ResourceQuota `memory-limit-quota`, whose pods declare no
// memory); the message is the quota admission plugin's own wording.

const NS = 'hotel-reservation'
const KOMPOSE = 'io.kompose.service'
const QUOTA_MESSAGE =
  'pods "search-7c9d6b8f5-qx4vz" is forbidden: failed quota: memory-limit-quota: must specify limits.memory for: hotel-reserv-search; requests.memory for: hotel-reserv-search'

const search: Deployment = {
  metadata: { name: 'search', namespace: NS },
  spec: { replicas: 1, selector: { matchLabels: { [KOMPOSE]: 'search' } } },
  status: { replicas: 0, readyReplicas: 0 },
}
const searchRs: ReplicaSet = {
  metadata: { name: 'search-7c9d6b8f5', namespace: NS, ownerReferences: [{ kind: 'Deployment', name: 'search' }] },
  status: {
    replicas: 0,
    conditions: [
      {
        type: 'ReplicaFailure',
        status: 'True',
        reason: 'FailedCreate',
        message: QUOTA_MESSAGE,
        lastTransitionTime: '2026-10-17T19:12:04Z',
      },
    ],
  },
}
const failedCreateEvent: K8sEvent = {
  involvedObject: { kind: 'ReplicaSet', name: 'search-7c9d6b8f5', namespace: NS },
  reason: 'FailedCreate',
  type: 'Warning',
  message: QUOTA_MESSAGE,
  count: 14,
  lastTimestamp: '2026-10-17T19:14:40Z',
}

describe('why a workload cannot get a pod (#1484)', () => {
  it('names the quota from the ReplicaSet condition', () => {
    const f = classifyDeployment(search, [], undefined, { replicaSets: [searchRs], events: [] })
    expect(f?.fault).toBe('create-failed')
    expect(f?.message).toBe(`Deployment search cannot create pods: ${QUOTA_MESSAGE}`)
    expect(f?.timestamp).toBe('2026-10-17T19:12:04Z')
    expect(f?.attributes).toMatchObject({
      'k8s.reason': 'FailedCreate',
      'k8s.blockedBy': 'resourcequota/memory-limit-quota',
      'k8s.desiredReplicas': 1,
      'k8s.readyReplicas': 0,
    })
  })

  it('falls back to the FailedCreate event when the condition is gone', () => {
    const rs: ReplicaSet = { ...searchRs, status: { replicas: 0 } }
    const f = classifyDeployment(search, [], undefined, { replicaSets: [rs], events: [failedCreateEvent] })
    expect(f?.fault).toBe('create-failed')
    expect(f?.timestamp).toBe('2026-10-17T19:14:40Z')
  })

  it("ignores another deployment's ReplicaSet and events", () => {
    const other: ReplicaSet = {
      ...searchRs,
      metadata: { name: 'geo-5f6', ownerReferences: [{ kind: 'Deployment', name: 'geo' }] },
    }
    const f = classifyDeployment(search, [], undefined, {
      replicaSets: [other],
      events: [{ ...failedCreateEvent, involvedObject: { kind: 'ReplicaSet', name: 'geo-5f6' } }],
    })
    expect(f?.fault).toBe('no-ready-replicas')
  })

  it('reads a pod the scheduler cannot place', () => {
    const pending: Pod = {
      metadata: { name: 'search-7c9d6b8f5-qx4vz', namespace: NS, labels: { [KOMPOSE]: 'search' } },
      status: { phase: 'Pending' },
    }
    const f = classifyDeployment(search, [pending], undefined, {
      replicaSets: [],
      events: [
        {
          involvedObject: { kind: 'Pod', name: 'search-7c9d6b8f5-qx4vz' },
          reason: 'FailedScheduling',
          type: 'Warning',
          message: '0/3 nodes are available: 3 Insufficient memory. preemption: 0/3 nodes are available: 3 No preemption victims found for incoming pod.',
          lastTimestamp: '2026-10-17T19:13:00Z',
        },
      ],
    })
    expect(f?.fault).toBe('unschedulable')
    expect(f?.message).toContain('3 Insufficient memory')
    expect(f?.attributes['k8s.blockedBy']).toBeUndefined()
  })

  it('stays no-ready-replicas when nothing was read', () => {
    expect(classifyDeployment(search, [])?.fault).toBe('no-ready-replicas')
  })

  it('names the object in each refusal shape it knows', () => {
    expect(blockingObject(QUOTA_MESSAGE)).toBe('resourcequota/memory-limit-quota')
    expect(blockingObject('pods "x" is forbidden: exceeded quota: compute-quota, requested: limits.memory=1Gi')).toBe(
      'resourcequota/compute-quota',
    )
    expect(blockingObject('admission webhook "mutation.gatekeeper.sh" denied the request: memory too high')).toBe(
      'webhook/mutation.gatekeeper.sh',
    )
    expect(
      blockingObject('Internal error occurred: failed calling webhook "webhook.cert-manager.io": connection refused'),
    ).toBe('webhook/webhook.cert-manager.io')
    expect(blockingObject('pods "x" is forbidden: error looking up service account hotel/search-sa: serviceaccount "search-sa" not found')).toBe(
      'serviceaccount/search-sa',
    )
    expect(blockingObject('pods "x" is forbidden: maximum memory usage per Container is 512Mi, but limit is 1Gi')).toBeUndefined()
  })

  it('lands the named cause on the service incident through a poll', async () => {
    const graph: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    const svc: ServiceNode = { id: serviceId('search'), type: NodeType.ServiceNode, name: 'search', language: 'go' }
    graph.addNode(svc.id, svc)
    const lists: Record<string, unknown[]> = {
      [deploymentsPath(NS)]: [search],
      [podsPath(NS)]: [],
      [replicaSetsPath(NS)]: [searchRs],
      [eventsPath(NS)]: [failedCreateEvent],
    }
    const fetchImpl = (async (url: string | URL) => {
      const items = lists[new URL(String(url)).pathname]
      if (!items) return { ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) } as Response
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ items }) } as Response
    }) as unknown as typeof fetch
    const { connector, resolveTarget } = createKubernetesConnector(
      graph,
      { namespace: NS, apiServerUrl: 'https://k8s.test' },
      fetchImpl,
    )
    const errorsPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'neat-k8s-causes-')), 'errors.ndjson')
    const ctx: ConnectorContext = { projectDir: '/repo', credentials: { token: 't' }, errorsPath }
    await runConnectorPoll(connector, ctx, graph, resolveTarget)
    const [event] = await readErrorEvents(errorsPath)
    expect(event?.affectedNode).toBe(svc.id)
    expect(event?.errorMessage).toContain('failed quota: memory-limit-quota')
    expect(event?.attributes?.['k8s.blockedBy']).toBe('resourcequota/memory-limit-quota')
  })
})
