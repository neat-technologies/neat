import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  DivergenceResultSchema,
  IncidentCardSchema,
  NodeType,
  Provenance,
  infraId,
  serviceId,
  type ConfigMismatchDivergence,
  type Divergence,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { computeDivergences } from '../src/divergences.js'
import { detectConfigMismatches } from '../src/config-drift.js'
import { composeNodeCard } from '../src/goodybag.js'
import { configMismatchPhrase } from '../src/incidents-render.js'

// Config drift (ADR-265): two configuration values that have to agree and don't.
// The fixtures carry the k8s substrate's `observedSpec` under the field names in
// connectors.md §10 (#1481 part 3): `selector`, `selectsWorkloads`, `ports` on a
// k8s-service node, `containerPorts` on a k8s-deployment node. `containerEnv` on
// the deployment spec and `listenPorts` / `declaredEnv` on the ServiceNode are
// read where present and minted by nothing yet; `observedDeployContext.containerEnv`
// is on main for a faulted workload.

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}

function addService(g: NeatGraph, name: string, extra: Record<string, unknown> = {}): string {
  const id = serviceId(name)
  g.addNode(id, { id, type: NodeType.ServiceNode, name, language: 'unknown', ...extra } as unknown as GraphNode)
  return id
}

function addInfra(g: NeatGraph, kind: string, name: string, observedSpec?: Record<string, unknown>): string {
  const id = infraId(kind, name)
  g.addNode(id, {
    id,
    type: NodeType.InfraNode,
    name,
    provider: 'kubernetes',
    kind,
    ...(observedSpec ? { observedSpec } : {}),
  } as unknown as GraphNode)
  return id
}

const addK8sService = (g: NeatGraph, name: string, spec?: Record<string, unknown>): string =>
  addInfra(g, 'k8s-service', name, spec)
const addDeployment = (g: NeatGraph, name: string, spec?: Record<string, unknown>): string =>
  addInfra(g, 'k8s-deployment', name, spec)

function configOnly(ds: Divergence[]): ConfigMismatchDivergence[] {
  return ds.filter((d): d is ConfigMismatchDivergence => d.type === 'config-mismatch')
}

describe('config-mismatch — Service selector', () => {
  it('a selector covering two workloads is one finding naming both, on the Service and its service node', () => {
    const g = newGraph()
    addService(g, 'frontend', { observedReadyReplicas: 1 })
    addService(g, 'search', { observedReadyReplicas: 1 })
    addDeployment(g, 'frontend')
    addDeployment(g, 'search')
    const svcId = addK8sService(g, 'frontend', {
      selector: { 'service-route': 'frontend' },
      selectsWorkloads: ['frontend', 'search'],
      selectorAmbiguous: true,
    })

    const result = computeDivergences(g)
    expect(DivergenceResultSchema.safeParse(result).success).toBe(true)
    const found = configOnly(result.divergences)
    expect(found).toHaveLength(1)
    const d = found[0]!
    expect(d.kind).toBe('selector-overlap')
    expect(d.source).toBe(svcId)
    expect(d.target).toBe('service:frontend')
    expect(d.field).toBe('spec.selector')
    expect(d.evidence.map((e) => [e.role, e.value, e.location])).toEqual([
      ['service selector', 'service-route=frontend', 'Service frontend spec.selector'],
      ['selected workload', 'frontend', 'Deployment frontend pod labels'],
      ['selected workload', 'search', 'Deployment search pod labels'],
    ])
    expect(d.evidence.every((e) => e.provenance === Provenance.OBSERVED)).toBe(true)
  })

  it('a selector covering exactly one workload is not a finding', () => {
    const g = newGraph()
    addService(g, 'frontend', { observedReadyReplicas: 1 })
    addK8sService(g, 'frontend', { selector: { app: 'frontend' }, selectsWorkloads: ['frontend'] })
    expect(configOnly(computeDivergences(g).divergences)).toEqual([])
  })

  it('a selector covering nothing while other workloads run is a selector-empty finding', () => {
    const g = newGraph()
    addService(g, 'cart', { observedReadyReplicas: 2 })
    addK8sService(g, 'cart', { selector: { app: 'cart' }, selectsWorkloads: ['cart'] })
    addK8sService(g, 'ad', { selector: { app: 'ad-typo' }, selectsWorkloads: [] })
    const found = configOnly(computeDivergences(g).divergences)
    expect(found.map((d) => [d.kind, d.source])).toEqual([['selector-empty', infraId('k8s-service', 'ad')]])
  })

  it('a selector covering nothing when nothing runs at all says nothing', () => {
    const g = newGraph()
    addK8sService(g, 'ad', { selector: { app: 'ad' }, selectsWorkloads: [] })
    expect(configOnly(computeDivergences(g).divergences)).toEqual([])
  })

  it('stays silent on a node with no observedSpec, or no selectsWorkloads', () => {
    const g = newGraph()
    addService(g, 'frontend', { observedReadyReplicas: 1 })
    addK8sService(g, 'frontend', { selector: { app: 'frontend' } })
    addK8sService(g, 'cart')
    expect(detectConfigMismatches(g)).toEqual([])
  })
})

describe('config-mismatch — caller address port', () => {
  it('a caller address naming a port the callee Service does not expose lands on both services, with both sides', () => {
    const g = newGraph()
    const checkout = addService(g, 'checkout')
    addDeployment(g, 'checkout', {
      containerPorts: [{ port: 5050, container: 'checkout' }],
      containerEnv: ['PRODUCT_CATALOG_ADDR=product-catalog:8082', 'OTEL_SERVICE_NAME=checkout'],
    })
    const catalog = addService(g, 'product-catalog')
    addK8sService(g, 'product-catalog', {
      ports: [{ name: 'tcp-service', port: 8080, targetPort: 8080 }],
    })

    const found = configOnly(computeDivergences(g).divergences)
    expect(found).toHaveLength(1)
    const d = found[0]!
    expect(d.kind).toBe('address-port')
    expect(d.source).toBe(checkout)
    expect(d.target).toBe(catalog)
    expect(d.field).toBe('PRODUCT_CATALOG_ADDR')
    expect(d.evidence).toEqual([
      {
        role: 'caller address',
        value: 'PRODUCT_CATALOG_ADDR=product-catalog:8082',
        location: 'Deployment checkout containers[].env PRODUCT_CATALOG_ADDR',
        provenance: Provenance.OBSERVED,
      },
      {
        role: 'service port',
        value: '8080',
        location: 'Service product-catalog spec.ports[0].port',
        provenance: Provenance.OBSERVED,
      },
    ])
    // No verdict: the phrase names both sides and neither as the culprit.
    const phrase = configMismatchPhrase(d)
    expect(phrase).toContain('PRODUCT_CATALOG_ADDR=product-catalog:8082')
    expect(phrase).toContain('8080')
    expect(phrase).not.toMatch(/wrong|bug|misconfig/i)

    // Node scoping reaches it from either end.
    expect(configOnly(computeDivergences(g, { node: catalog }).divergences)).toHaveLength(1)
    expect(configOnly(computeDivergences(g, { node: checkout }).divergences)).toHaveLength(1)
  })

  it('a matching port is not a finding', () => {
    const g = newGraph()
    addService(g, 'checkout')
    addDeployment(g, 'checkout', { containerEnv: ['PRODUCT_CATALOG_ADDR=product-catalog:8080'] })
    addService(g, 'product-catalog')
    addK8sService(g, 'product-catalog', { ports: [{ port: 8080, targetPort: 8080 }] })
    expect(detectConfigMismatches(g)).toEqual([])
  })

  it('reads the faulted-workload env on main today, a URL value and a cluster FQDN', () => {
    const g = newGraph()
    addService(g, 'frontend', {
      observedDeployContext: {
        incidentId: 'k8s:deploy:ns:frontend:crash-loop',
        observedAt: '2026-10-18T00:00:00.000Z',
        containerEnv: ['CART_ADDR=http://cart.shop.svc.cluster.local:7071/api'],
      },
    })
    addService(g, 'cart')
    addDeployment(g, 'cart', { containerPorts: [{ port: 7070, name: 'grpc', container: 'cart' }] })
    const found = detectConfigMismatches(g)
    expect(found.map((d) => [d.kind, d.source, d.target, d.field])).toEqual([
      ['address-port', 'service:frontend', 'service:cart', 'CART_ADDR'],
    ])
    expect(found[0]!.evidence[0]!.location).toBe('pod of frontend containers[].env CART_ADDR')
    expect(found[0]!.evidence[1]).toMatchObject({
      role: 'container port',
      value: '7070 (grpc)',
      location: 'Deployment cart containers[cart].ports[].containerPort',
    })
  })

  it('pairs a *_PORT var with its sibling *_HOST var, against a code-declared listen port', () => {
    const g = newGraph()
    addService(g, 'frontend-proxy')
    addDeployment(g, 'frontend-proxy', { containerEnv: ['FRONTEND_HOST=frontend', 'FRONTEND_PORT=9090'] })
    addService(g, 'frontend', { listenPorts: [{ port: 8080, file: 'src/server.ts', line: 12 }] })
    const found = detectConfigMismatches(g)
    expect(found).toHaveLength(1)
    expect(found[0]!.field).toBe('FRONTEND_PORT')
    expect(found[0]!.evidence[1]).toEqual({
      role: 'declared listen port',
      value: '8080',
      location: 'src/server.ts:12',
      provenance: Provenance.EXTRACTED,
    })
  })

  it('one finding when the declared and the live env name the same port, both sources listed', () => {
    const g = newGraph()
    addService(g, 'checkout', {
      declaredEnv: [{ name: 'PRODUCT_CATALOG_ADDR', value: 'product-catalog:8082', file: 'k8s/checkout.yaml', line: 40 }],
    })
    addDeployment(g, 'checkout', { containerEnv: ['PRODUCT_CATALOG_ADDR=product-catalog:8082'] })
    addService(g, 'product-catalog')
    addDeployment(g, 'product-catalog', { containerPorts: [{ port: 8080 }] })
    const found = detectConfigMismatches(g)
    expect(found).toHaveLength(1)
    expect(found[0]!.evidence.map((e) => [e.role, e.provenance])).toEqual([
      ['caller address', Provenance.OBSERVED],
      ['caller address', Provenance.EXTRACTED],
      ['container port', Provenance.OBSERVED],
    ])
    expect(found[0]!.evidence[1]!.location).toBe('k8s/checkout.yaml:40')
  })

  it('says nothing when the callee exposes no known port, the host is unknown, loopback, or a reference', () => {
    const g = newGraph()
    addService(g, 'checkout')
    addDeployment(g, 'checkout', {
      containerEnv: [
        'PAYMENT_ADDR=payment:50051',
        'UNKNOWN_ADDR=nowhere:1234',
        'SELF_HOST=localhost:9999',
        'EMAIL_ADDR=<from configMap shop key email>',
        'DB_URL=postgres://user:***REDACTED***@db:5432/x',
        'CHECKOUT_PORT=1',
      ],
    })
    addService(g, 'payment')
    expect(detectConfigMismatches(g)).toEqual([])
  })
})

describe('config-mismatch — Service targetPort', () => {
  it('a targetPort no selected container declares is a finding on the Service and the workload', () => {
    const g = newGraph()
    addService(g, 'ad', { observedReadyReplicas: 1 })
    addDeployment(g, 'ad', { containerPorts: [{ port: 9555 }] })
    const svcId = addK8sService(g, 'ad', {
      selector: { app: 'ad' },
      selectsWorkloads: ['ad'],
      ports: [{ port: 9555, targetPort: 9556 }],
    })
    const found = detectConfigMismatches(g)
    expect(found.map((d) => [d.kind, d.source, d.target, d.field])).toEqual([
      ['target-port', svcId, 'service:ad', 'spec.ports[0].targetPort'],
    ])
    expect(found[0]!.evidence.map((e) => [e.role, e.value])).toEqual([
      ['service targetPort', '9556'],
      ['container port', '9555'],
    ])
  })

  it('a named targetPort resolves against named container ports', () => {
    const g = newGraph()
    addDeployment(g, 'ad', { containerPorts: [{ port: 9555, name: 'grpc' }] })
    addK8sService(g, 'ad', { selectsWorkloads: ['ad'], ports: [{ port: 9555, targetPort: 'grpc' }] })
    expect(detectConfigMismatches(g)).toEqual([])
    addK8sService(g, 'ad-alt', { selectsWorkloads: ['ad'], ports: [{ port: 9555, targetPort: 'http' }] })
    expect(detectConfigMismatches(g).map((d) => [d.source, d.target])).toEqual([
      [infraId('k8s-service', 'ad-alt'), infraId('k8s-deployment', 'ad')],
    ])
  })

  it('an unset targetPort defaults to port, and a workload with no known ports says nothing', () => {
    const g = newGraph()
    addDeployment(g, 'ad', { containerPorts: [{ port: 9555 }] })
    addDeployment(g, 'quote', { containerPorts: [] })
    addK8sService(g, 'ad', { selectsWorkloads: ['ad'], ports: [{ port: 9555 }] })
    addK8sService(g, 'quote', { selectsWorkloads: ['quote'], ports: [{ port: 8090, targetPort: 8091 }] })
    expect(detectConfigMismatches(g)).toEqual([])
  })
})

describe('config-mismatch on the incident card', () => {
  it('a node card carries the mismatch through its existing divergence field, with no incident recorded', () => {
    const g = newGraph()
    addService(g, 'checkout')
    addDeployment(g, 'checkout', { containerEnv: ['PRODUCT_CATALOG_ADDR=product-catalog:8082'] })
    const catalog = addService(g, 'product-catalog')
    addK8sService(g, 'product-catalog', { ports: [{ port: 8080, targetPort: 8080 }] })

    const card = composeNodeCard(g, catalog, [], [])
    expect(IncidentCardSchema.safeParse(card).success).toBe(true)
    const div = card.divergence ?? []
    expect(div.map((d) => d.type)).toEqual(['config-mismatch'])
    expect(div[0]!.summary).toContain('PRODUCT_CATALOG_ADDR=product-catalog:8082')
    expect(div[0]!.summary).toContain('Service product-catalog spec.ports[0].port')
  })
})
