import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { MultiDirectedGraph } from 'graphology'
import { NodeType, serviceId, type GraphEdge, type GraphNode, type ServiceNode } from '@neat.is/types'
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import { readErrorEvents } from '../src/ingest.js'
import {
  classifyDeployment,
  createKubernetesConnector,
  deploymentsPath,
  mapWorkloadsToSignals,
  parseKubeconfig,
  podsPath,
  readK8sCredentials,
  resolveK8sTransport,
  type Deployment,
  type K8sConnectorConfig,
  type K8sList,
  type Pod,
} from '../src/connectors/kubernetes/index.js'
import type { NeatGraph } from '../src/graph.js'

// ADR-224 (#1124) — the Kubernetes deploy-state connector, the second
// incident-emitting connector (connectors.md §10). These tests drive real k8s
// API list shapes (mock fixtures mirroring the three bench faults + a healthy
// control) through the connector and assert each unhealthy workload becomes an
// OBSERVED incident on the service node — the faults a dead pod emits no span
// for, which is the whole point (#1124).

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEPLOYMENTS_LIST = JSON.parse(
  readFileSync(path.resolve(__dirname, 'fixtures/kubernetes/deployments.json'), 'utf8'),
) as K8sList<Deployment>
const PODS_LIST = JSON.parse(
  readFileSync(path.resolve(__dirname, 'fixtures/kubernetes/pods.json'), 'utf8'),
) as K8sList<Pod>
const DEPLOYMENTS = DEPLOYMENTS_LIST.items ?? []
const PODS = PODS_LIST.items ?? []

const NS = 'otel-demo'
const CONFIG: K8sConnectorConfig = { namespace: NS }

function newGraph(services: string[]): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const name of services) {
    const node: ServiceNode = { id: serviceId(name), type: NodeType.ServiceNode, name, language: 'go' }
    g.addNode(node.id, node)
  }
  return g
}

// A fake k8s API: routes the list GET to the right fixture by path. `apiUrl` in
// the connector config points here, but the stub ignores the host and keys on
// the resource path — the same request-shape the real API answers.
function stubK8sFetch(): typeof fetch {
  return (async (input: string | URL): Promise<Response> => {
    const url = String(input)
    const body = url.includes('/deployments') ? DEPLOYMENTS_LIST : url.includes('/pods') ? PODS_LIST : { items: [] }
    return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response
  }) as unknown as typeof fetch
}

function freshErrorsPath(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'neat-k8s-')), 'errors.ndjson')
}

describe('kubernetes connector — mapping cluster state to deploy-fault incidents (ADR-224)', () => {
  it('maps each unhealthy workload to one incident and leaves the healthy one alone', () => {
    const signals = mapWorkloadsToSignals(DEPLOYMENTS, PODS, CONFIG)
    // product-catalog (image-pull) + ad (scaled-to-zero) + recommendation (crash-loop); frontend is healthy.
    expect(signals).toHaveLength(3)
    const byService = Object.fromEntries(signals.map((s) => [s.incident!.service, s]))

    const pc = byService['product-catalog']!
    expect(pc.incident!.id).toBe('k8s:deploy:otel-demo:product-catalog:image-pull')
    expect(pc.incident!.errorType).toBe('k8s-deploy-failure')
    expect(pc.incident!.errorMessage).toContain('cannot pull image app-image:latest')
    expect(pc.incident!.attributes!['k8s.fault']).toBe('image-pull')
    expect(pc.incident!.attributes!['k8s.image']).toBe('app-image:latest')
    // Incident-only signal — no edge, so no counts.
    expect(pc.callCount).toBe(0)
    expect(pc.errorCount).toBe(0)

    const ad = byService['ad']!
    expect(ad.incident!.id).toBe('k8s:deploy:otel-demo:ad:scaled-to-zero')
    expect(ad.incident!.errorMessage).toContain('scaled to 0')
    expect(ad.incident!.attributes!['k8s.desiredReplicas']).toBe(0)

    const rec = byService['recommendation']!
    expect(rec.incident!.id).toBe('k8s:deploy:otel-demo:recommendation:crash-loop')
    expect(rec.incident!.errorMessage).toContain('crashlooping (restarts: 7)')
    expect(rec.incident!.errorMessage).toContain('cannot reach feature-flag service')
    expect(rec.incident!.attributes!['k8s.restartCount']).toBe(7)
    expect(rec.incident!.attributes!['k8s.terminatedReason']).toBe('Error')

    expect(byService['frontend']).toBeUndefined()
  })

  it('classifyDeployment returns null for a fully-ready workload and the right fault otherwise', () => {
    const by = Object.fromEntries(DEPLOYMENTS.map((d) => [d.metadata!.name, d]))
    expect(classifyDeployment(by['frontend']!, PODS)).toBeNull()
    expect(classifyDeployment(by['product-catalog']!, PODS)?.fault).toBe('image-pull')
    expect(classifyDeployment(by['ad']!, PODS)?.fault).toBe('scaled-to-zero')
    expect(classifyDeployment(by['recommendation']!, PODS)?.fault).toBe('crash-loop')
  })

  it('a not-ready deployment whose pods name no cause is an honest no-ready-replicas', () => {
    const pending: Deployment = {
      metadata: { name: 'checkout', namespace: NS, labels: { app: 'checkout' } },
      spec: { replicas: 3, selector: { matchLabels: { app: 'checkout' } } },
      status: { replicas: 3, readyReplicas: 0 },
    }
    const finding = classifyDeployment(pending, []) // no pods carry a waiting reason
    expect(finding?.fault).toBe('no-ready-replicas')
    expect(finding?.message).toContain('desired 3, ready 0')
  })
})

describe('kubernetes connector — full pull/map/fuse onto the extracted service node', () => {
  it('the three bench faults land as OBSERVED incidents on the service nodes the extractor built', async () => {
    const graph = newGraph(['product-catalog', 'ad', 'recommendation'])
    const { connector, resolveTarget } = createKubernetesConnector(
      graph,
      { namespace: NS, apiServerUrl: 'https://k8s.test' },
      stubK8sFetch(),
    )
    const errorsPath = freshErrorsPath()
    const ctx: ConnectorContext = { projectDir: '/repo', credentials: { token: 't' }, errorsPath, project: NS }

    const result = await runConnectorPoll(connector, ctx, graph, resolveTarget)
    expect(result.signalCount).toBe(3)

    const events = await readErrorEvents(errorsPath)
    expect(events).toHaveLength(3)
    const byNode = Object.fromEntries(events.map((e) => [e.affectedNode, e]))

    // The fusion assertion: each incident's affectedNode is the exact ServiceNode
    // id the extractor produced — one node, both the code deps and this OBSERVED
    // deploy incident, never a connector-minted twin.
    expect(byNode[serviceId('product-catalog')]!.errorMessage).toContain('cannot pull image')
    expect(byNode[serviceId('ad')]!.errorMessage).toContain('scaled to 0')
    expect(byNode[serviceId('recommendation')]!.errorMessage).toContain('crashlooping')
    for (const ev of events) expect(ev.errorType).toBe('k8s-deploy-failure')
  })

  it('drops the incident honestly when there is no ledger to write to (no errorsPath)', async () => {
    const graph = newGraph(['product-catalog', 'ad', 'recommendation'])
    const { connector, resolveTarget } = createKubernetesConnector(
      graph,
      { namespace: NS, apiServerUrl: 'https://k8s.test' },
      stubK8sFetch(),
    )
    // No errorsPath — a programmatic caller that opted out; incidents drop, never throw.
    const result = await runConnectorPoll(
      connector,
      { projectDir: '/repo', credentials: { token: 't' } },
      graph,
      resolveTarget,
    )
    expect(result.signalCount).toBe(3)
    expect(result.unresolved).toBe(3)
    expect(result.edgesCreated).toBe(0)
  })
})

describe('kubernetes connector — credential hygiene (connectors.md §6)', () => {
  it('never writes the credential into any emitted signal or incident', async () => {
    const token = 'k8s-SECRET-TOKEN-98765'
    const graph = newGraph(['product-catalog', 'ad', 'recommendation'])
    const { connector, resolveTarget } = createKubernetesConnector(
      graph,
      { namespace: NS, apiServerUrl: 'https://k8s.test' },
      stubK8sFetch(),
    )
    const errorsPath = freshErrorsPath()
    await runConnectorPoll(
      connector,
      { projectDir: '/repo', credentials: { token }, errorsPath, project: NS },
      graph,
      resolveTarget,
    )
    const events = await readErrorEvents(errorsPath)
    expect(JSON.stringify(events)).not.toContain(token)
    // and the mapping-level signals never carry it either
    expect(JSON.stringify(mapWorkloadsToSignals(DEPLOYMENTS, PODS, CONFIG))).not.toContain(token)
  })
})

describe('kubernetes connector — credential + transport resolution', () => {
  it('readK8sCredentials requires a token or a kubeconfig', () => {
    expect(() => readK8sCredentials({})).toThrow(/token or a kubeconfig/)
    expect(readK8sCredentials({ token: 't' })).toEqual({ token: 't' })
    expect(readK8sCredentials({ kubeconfig: '/home/u/.kube/config' })).toEqual({ kubeconfig: '/home/u/.kube/config' })
  })

  it('resolveK8sTransport uses the token + apiServerUrl path, and requires the URL', () => {
    expect(resolveK8sTransport({ token: 'tok' }, { namespace: NS, apiServerUrl: 'https://k8s.test', caCert: 'CA' })).toEqual({
      server: 'https://k8s.test',
      token: 'tok',
      ca: 'CA',
      insecureSkipTlsVerify: false,
    })
    expect(() => resolveK8sTransport({ token: 't' }, { namespace: NS })).toThrow(/apiServerUrl is required/)
  })

  it('parseKubeconfig reads the current context: server, CA, and token auth', () => {
    const kc = [
      'apiVersion: v1',
      'clusters:',
      '- name: kind-neat',
      '  cluster:',
      '    server: https://127.0.0.1:6443',
      `    certificate-authority-data: ${Buffer.from('CA-PEM-BYTES').toString('base64')}`,
      'contexts:',
      '- name: kind-neat',
      '  context: { cluster: kind-neat, user: kind-neat }',
      'current-context: kind-neat',
      'users:',
      '- name: kind-neat',
      '  user: { token: sa-token-abc }',
    ].join('\n')
    const t = parseKubeconfig(kc)
    expect(t.server).toBe('https://127.0.0.1:6443')
    expect(t.ca).toBe('CA-PEM-BYTES')
    expect(t.token).toBe('sa-token-abc')
    expect(t.insecureSkipTlsVerify).toBe(false)
  })

  it('parseKubeconfig reads client-certificate auth (a kind cluster default)', () => {
    const kc = [
      'apiVersion: v1',
      'clusters:',
      '- name: kind',
      '  cluster: { server: https://127.0.0.1:6443, insecure-skip-tls-verify: true }',
      'contexts:',
      '- name: kind',
      '  context: { cluster: kind, user: kind }',
      'current-context: kind',
      'users:',
      '- name: kind',
      '  user:',
      `    client-certificate-data: ${Buffer.from('CERT-PEM').toString('base64')}`,
      `    client-key-data: ${Buffer.from('KEY-PEM').toString('base64')}`,
    ].join('\n')
    const t = parseKubeconfig(kc)
    expect(t.server).toBe('https://127.0.0.1:6443')
    expect(t.insecureSkipTlsVerify).toBe(true)
    expect(t.clientCert).toBe('CERT-PEM')
    expect(t.clientKey).toBe('KEY-PEM')
    expect(t.token).toBeUndefined()
  })

  it('builds the namespaced read-only list paths', () => {
    expect(deploymentsPath('otel-demo')).toBe('/apis/apps/v1/namespaces/otel-demo/deployments')
    expect(podsPath('otel-demo')).toBe('/api/v1/namespaces/otel-demo/pods')
  })
})
