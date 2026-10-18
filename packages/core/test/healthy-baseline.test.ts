import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { MultiDirectedGraph } from 'graphology'
import { EdgeType, NodeType, Provenance, type ErrorEvent, type GraphEdge, type GraphNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import {
  configMapsPath,
  createKubernetesConnector,
  deploymentsPath,
  podsPath,
  servicesPath,
  networkPoliciesPath,
  deploymentSpecSignal,
  type ConfigMap,
  type Deployment,
  type Pod,
  type Service,
} from '../src/connectors/kubernetes/index.js'
import { changesSinceHealthy, failureOnset, resetBaselineState } from '../src/healthy-baseline.js'
import { diffSpecs } from '../src/spec-diff.js'
import { buildApi } from '../src/api.js'

// #1494 / ADR-270 — the card leads with what changed since the system was healthy.
// The two frontend Deployments are astronomy-shop's, read off the box's cluster
// during SREGym's missing_env_variable_astronomy_shop on 2026-10-18: the healthy
// spec at 12:05:31Z and the injected one at 12:07:05Z, CART_ADDR removed from
// frontend's env (status stripped; no secrets in either).

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (n: string): Deployment =>
  JSON.parse(readFileSync(path.join(here, 'fixtures', 'healthy-baseline', `${n}.json`), 'utf8')) as Deployment
const NS = 'astronomy-shop'

function ready(d: Deployment): Deployment {
  return { ...d, status: { replicas: 1, readyReplicas: 1, availableReplicas: 1 } }
}
function deployment(name: string, image = `img/${name}:1`): Deployment {
  return ready({
    metadata: { name, namespace: NS },
    spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { spec: { containers: [{ name, image }] } } },
  })
}
function pod(name: string): Pod {
  return {
    metadata: { name: `${name}-abc`, namespace: NS, labels: { app: name, 'opentelemetry.io/name': name } },
    status: { phase: 'Running', containerStatuses: [{ name, ready: true, restartCount: 0, state: { running: {} } }] },
  }
}

interface Lists {
  deployments: Deployment[]
  pods: Pod[]
  services: Service[]
  configMaps: ConfigMap[]
  networkPolicies?: unknown[]
}
function stubFetch(lists: Lists): typeof fetch {
  return (async (url: string | URL) => {
    const p = new URL(String(url)).pathname
    const items =
      p === deploymentsPath(NS) ? lists.deployments
        : p === podsPath(NS) ? lists.pods
          : p === servicesPath(NS) ? lists.services
            : p === configMapsPath(NS) ? lists.configMaps
              : p === networkPoliciesPath(NS) ? (lists.networkPolicies ?? [])
                : undefined
    if (items === undefined) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ items }) } as Response
  }) as unknown as typeof fetch
}

let dir: string
let errorsPath: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-healthy-'))
  errorsPath = path.join(dir, 'errors.ndjson')
  resetBaselineState()
  process.env.NEAT_BASELINE_HOLD_MS = '0'
})
afterEach(async () => {
  delete process.env.NEAT_BASELINE_HOLD_MS
  await fs.rm(dir, { recursive: true, force: true })
})

// astronomy's shape: frontend-proxy calls frontend, each service runs on its
// Deployment (the manifest extractor's RUNS_ON).
function graph(): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const s of ['frontend-proxy', 'frontend', 'checkout']) {
    g.addNode(`service:${s}`, { id: `service:${s}`, type: NodeType.ServiceNode, name: s, language: 'ts' } as GraphNode)
    const d = `infra:k8s-deployment:${s}`
    g.addNode(d, { id: d, type: NodeType.InfraNode, name: s, provider: 'kubernetes', kind: 'k8s-deployment' } as unknown as GraphNode)
    const e = `RUNS_ON:service:${s}->${d}`
    g.addEdgeWithKey(e, `service:${s}`, d, { id: e, source: `service:${s}`, target: d, type: EdgeType.RUNS_ON, provenance: Provenance.EXTRACTED } as GraphEdge)
  }
  const c = 'CALLS:OBSERVED:service:frontend-proxy->service:frontend'
  g.addEdgeWithKey(c, 'service:frontend-proxy', 'service:frontend', {
    id: c,
    source: 'service:frontend-proxy',
    target: 'service:frontend',
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    callCount: 100,
    signal: { spanCount: 100, errorCount: 0 },
  } as GraphEdge)
  return g
}

async function poll(g: NeatGraph, lists: Lists): Promise<void> {
  const { connector, resolveTarget } = createKubernetesConnector(g, { namespace: NS, apiServerUrl: 'https://k8s.test' }, stubFetch(lists))
  const ctx: ConnectorContext = { projectDir: '/repo', credentials: { token: 't' }, errorsPath }
  await runConnectorPoll(connector, ctx, g, resolveTarget)
}

function healthyLists(frontend: Deployment): Lists {
  return {
    deployments: [ready(frontend), deployment('frontend-proxy'), deployment('checkout')],
    pods: [pod('frontend'), pod('frontend-proxy'), pod('checkout')],
    services: [],
    configMaps: [{ metadata: { name: 'flagd-config', namespace: NS }, data: { 'demo.flagd.json': '{"flags":{"adFailure":{"defaultVariant":"off"}}}' } }],
  }
}

async function incident(node: string, at: Date): Promise<void> {
  const ev: ErrorEvent = {
    id: `t:${at.getTime()}`,
    timestamp: at.toISOString(),
    service: node.replace(/^service:/, ''),
    traceId: 't',
    spanId: String(at.getTime()),
    errorMessage: 'HTTP 502 upstream connect error',
    affectedNode: node,
  } as ErrorEvent
  await fs.appendFile(errorsPath, JSON.stringify(ev) + '\n')
}

async function manifests(): Promise<Array<{ takenAt: string; objects: Record<string, { hash: string }> }>> {
  try {
    return (await fs.readFile(path.join(dir, 'baselines.ndjson'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

// The spec the leg stamps on the node (#1490, #1503, ADR-270).
const stamped = (d: Deployment): Record<string, unknown> => deploymentSpecSignal(d)!.infraSpec!.spec

describe('the spec diff reads named lists by name (ADR-270)', () => {
  it('missing_env_variable: one removed env var, not a shifted list', () => {
    expect(diffSpecs(stamped(fixture('astronomy-frontend-healthy')), stamped(fixture('astronomy-frontend-missing-env')))).toEqual([
      { path: '/containers/frontend/env/CART_ADDR', before: {} },
    ])
  })

  it('a variable defined twice keeps both definitions (the shadowing shape)', () => {
    const d = fixture('astronomy-frontend-healthy')
    const c = d.spec!.template!.spec!.containers![0]!
    const shadowed: Deployment = {
      ...d,
      spec: { ...d.spec, template: { ...d.spec!.template, spec: { ...d.spec!.template!.spec, containers: [{ ...c, env: [...(c.env ?? []), { name: 'FLAGD_HOST', value: 'localhost' }] }] } } },
    }
    expect(diffSpecs(stamped(d), stamped(shadowed))).toEqual([{ path: '/containers/frontend/env/FLAGD_HOST#2', after: {} }])
  })

  it('a scale-down is a changed replicas field', () => {
    const d = fixture('astronomy-frontend-healthy')
    expect(diffSpecs(stamped(d), stamped({ ...d, spec: { ...d.spec, replicas: 0 } }))).toEqual([{ path: '/replicas', before: 1, after: 0 }])
  })
})

describe('the healthy baseline and the changes since it (ADR-270)', () => {
  it('a healthy namespace writes one baseline after two polls, content-addressed, values hashed', async () => {
    const g = graph()
    await poll(g, healthyLists(fixture('astronomy-frontend-healthy')))
    expect(await manifests()).toEqual([])
    await poll(g, healthyLists(fixture('astronomy-frontend-healthy')))
    const m = await manifests()
    expect(m).toHaveLength(1)
    expect(Object.keys(m[0]!.objects).sort()).toEqual([
      'k8s:k8s-configmap/astronomy-shop/flagd-config',
      'k8s:k8s-deployment/astronomy-shop/checkout',
      'k8s:k8s-deployment/astronomy-shop/frontend',
      'k8s:k8s-deployment/astronomy-shop/frontend-proxy',
    ])
    // Unchanged state writes nothing more.
    await poll(g, healthyLists(fixture('astronomy-frontend-healthy')))
    expect(await manifests()).toHaveLength(1)
    // A ConfigMap value never reaches disk, only its hash.
    const files = await fs.readdir(path.join(dir, 'baselines', 'objects'))
    const all = (await Promise.all(files.map((f) => fs.readFile(path.join(dir, 'baselines', 'objects', f), 'utf8')))).join('\n')
    expect(all).not.toContain('adFailure')
    expect(all).toContain('sha256:')
  })

  it('missing_env_variable: the card for the failing proxy leads with frontend losing CART_ADDR', async () => {
    const g = graph()
    for (let i = 0; i < 2; i++) await poll(g, healthyLists(fixture('astronomy-frontend-healthy')))
    const before = await manifests()
    // The injection, then the proxy starts failing; the next poll must not roll the baseline.
    await poll(g, healthyLists(fixture('astronomy-frontend-missing-env')))
    await incident('service:frontend-proxy', new Date())
    await poll(g, healthyLists(fixture('astronomy-frontend-missing-env')))
    await poll(g, healthyLists(fixture('astronomy-frontend-missing-env')))
    const after = await manifests()
    // The poll after the injection was still healthy by Kubernetes, but a changed
    // state starts the hold again, and by the next one the proxy is failing.
    expect(after.length).toBe(before.length)

    const incidents = (await fs.readFile(errorsPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as ErrorEvent)
    const onset = failureOnset(incidents, 'service:frontend-proxy')!
    const res = await changesSinceHealthy(g, dir, { at: onset, from: 'service:frontend-proxy' })
    expect(res.base).not.toBeNull()
    expect(Date.parse(res.base!.takenAt)).toBeLessThan(Date.parse(onset))

    const app = await buildApi({ graph: g, errorsPath })
    try {
      const card = (await app.inject({ method: 'GET', url: '/graph/incident-card/service:frontend-proxy' })).json()
      expect(card.changedSinceHealthy.provenance).toBe('OBSERVED')
      expect(card.headline).toContain(
        'changed since healthy: k8s-deployment frontend: containers/frontend/env/CART_ADDR removed',
      )
      const changes = (await app.inject({ method: 'GET', url: '/graph/changes?from=service:frontend-proxy' })).json()
      expect(changes.changes[0]).toMatchObject({
        id: 'k8s:k8s-deployment/astronomy-shop/frontend',
        kind: 'object',
        change: 'modified',
        distance: 2,
        fields: [{ path: '/containers/frontend/env/CART_ADDR', before: {} }],
      })
    } finally {
      await app.close()
    }
  })

  it('a baseline written after the onset is never the base', async () => {
    const g = graph()
    for (let i = 0; i < 2; i++) await poll(g, healthyLists(fixture('astronomy-frontend-healthy')))
    const [first] = await manifests()
    const onset = new Date(Date.parse(first!.takenAt) + 1000).toISOString()
    // A later baseline that already holds the fault.
    resetBaselineState()
    await new Promise((r) => setTimeout(r, 1100))
    for (let i = 0; i < 2; i++) await poll(g, healthyLists(fixture('astronomy-frontend-missing-env')))
    expect((await manifests()).length).toBe(2)
    const res = await changesSinceHealthy(g, dir, { at: onset })
    expect(res.base!.takenAt).toBe(first!.takenAt)
    expect(res.changes.map((c) => c.id)).toEqual(['k8s:k8s-deployment/astronomy-shop/frontend'])
  })

  it('an object removed or added since healthy shows', async () => {
    const g = graph()
    for (let i = 0; i < 2; i++) await poll(g, healthyLists(fixture('astronomy-frontend-healthy')))
    const lists = healthyLists(fixture('astronomy-frontend-healthy'))
    lists.deployments = lists.deployments.filter((d) => d.metadata?.name !== 'checkout')
    lists.deployments.push(deployment('chaos-proxy'))
    await incident('service:frontend-proxy', new Date())
    await poll(g, lists)
    const res = await changesSinceHealthy(g, dir, { at: new Date(Date.now() + 1000).toISOString() })
    expect(res.changes.map((c) => `${c.change} ${c.id}`).sort()).toEqual([
      'added k8s:k8s-deployment/astronomy-shop/chaos-proxy',
      'removed k8s:k8s-deployment/astronomy-shop/checkout',
    ])
  })

  // network_policy_block: a deny-all NetworkPolicy appears. #1499 (ADR-266) reads
  // the kind; its specs join the baseline with no change here.
  it('a NetworkPolicy that appears after healthy is an added object', async () => {
    const g = graph()
    for (let i = 0; i < 2; i++) await poll(g, healthyLists(fixture('astronomy-frontend-healthy')))
    const lists = healthyLists(fixture('astronomy-frontend-healthy'))
    lists.networkPolicies = [{ metadata: { name: 'deny-all', namespace: NS }, spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] } }]
    await incident('service:frontend-proxy', new Date())
    await poll(g, lists)
    const res = await changesSinceHealthy(g, dir, { at: new Date(Date.now() + 1000).toISOString() })
    expect(res.changes.map((c) => `${c.change} ${c.id}`)).toEqual(['added k8s:k8s-networkpolicy/astronomy-shop/deny-all'])
  })

  it('an edge that started erroring shows; one erroring at baseline does not', async () => {
    const g = graph()
    const e = g.getEdgeAttributes('CALLS:OBSERVED:service:frontend-proxy->service:frontend') as GraphEdge
    for (let i = 0; i < 2; i++) await poll(g, healthyLists(fixture('astronomy-frontend-healthy')))
    g.mergeEdgeAttributes('CALLS:OBSERVED:service:frontend-proxy->service:frontend', { signal: { ...e.signal!, errorCount: 7 } })
    const res = await changesSinceHealthy(g, dir, { at: new Date(Date.now() + 1000).toISOString(), from: 'service:frontend-proxy' })
    expect(res.changes).toEqual([
      expect.objectContaining({ kind: 'edge', change: 'started-erroring', fields: [{ path: '/errorCount', before: 0, after: 7 }], distance: 0 }),
    ])
  })

  it('no baseline yet, or none before the onset: base is null and the card has no section', async () => {
    const g = graph()
    expect((await changesSinceHealthy(g, dir, {})).base).toBeNull()
    const app = await buildApi({ graph: g, errorsPath })
    try {
      await incident('service:frontend-proxy', new Date())
      const card = (await app.inject({ method: 'GET', url: '/graph/incident-card/service:frontend-proxy' })).json()
      expect(card.changedSinceHealthy).toBeUndefined()
      expect(card.headline).not.toContain('changed since healthy')
      expect((await app.inject({ method: 'GET', url: '/graph/changes?at=yesterday' })).statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
