import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MultiDirectedGraph } from 'graphology'
import { EdgeType, NodeType, type GraphEdge, type GraphNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import {
  ensureServiceNode,
  handleSpan,
  mergeObservedDeployState,
  promoteFrontierNodes,
  type IngestContext,
} from '../src/ingest.js'
import { parseOtlpRequest } from '../src/otel.js'
import { addressesByDeployment, mapWorkloadsToSignals } from '../src/connectors/kubernetes/map.js'
import { parseK8sTargetName, type Deployment, type Pod, type Service } from '../src/connectors/kubernetes/types.js'

// #1411 — SREGym astronomy-shop (OTel demo 2.2.0). checkout's Go gRPC client spans
// carry the callee as a Service ClusterIP in `server.address`, so every one landed
// on a frontier:10.96.x.x node instead of service:cart and friends. The k8s
// substrate reads the namespace's Services and stamps each workload's ClusterIPs on
// its ServiceNode (ADR-248); ingest looks a bare IP up there once before it mints a
// frontier. IPs, names and selectors below are the bench cluster's.

const NAME_LABEL = 'opentelemetry.io/name'

function deployment(name: string): Deployment {
  return {
    metadata: { name, namespace: 'astronomy-shop' },
    spec: { replicas: 1, selector: { matchLabels: { [NAME_LABEL]: name } } },
    status: { replicas: 1, readyReplicas: 1 },
  }
}
function pod(name: string): Pod {
  return {
    metadata: {
      name: `${name}-abc12`,
      namespace: 'astronomy-shop',
      labels: { [NAME_LABEL]: name, 'app.kubernetes.io/instance': 'astronomy-shop' },
    },
    status: { phase: 'Running' },
  } as Pod
}
function service(name: string, ip: string, selector: Record<string, string> = { [NAME_LABEL]: name }): Service {
  return { metadata: { name, namespace: 'astronomy-shop' }, spec: { clusterIP: ip, selector } }
}

const WORKLOADS = ['checkout', 'cart', 'currency', 'payment', 'product-catalog']
const SERVICES: Service[] = [
  service('checkout', '10.96.124.37'),
  service('cart', '10.96.246.31'),
  service('currency', '10.96.24.162'),
  service('payment', '10.96.19.87'),
  service('product-catalog', '10.96.247.8'),
  // Selects every pod in the release: names no single workload.
  service('grafana', '10.96.26.252', { 'app.kubernetes.io/instance': 'astronomy-shop' }),
  // Headless.
  service('opensearch-headless', 'None', { [NAME_LABEL]: 'opensearch' }),
]

// checkout's client span, as the capture records it.
function grpcClientSpan(ip: string, rpcService: string, method: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: '0af7651916cd43dd8448eb211c80319c',
                spanId: 'b7ad6b7169203331',
                name: `${rpcService}/${method}`,
                kind: 3,
                startTimeUnixNano: '1760648000000000000',
                endTimeUnixNano: '1760648000004000000',
                attributes: [
                  { key: 'rpc.system', value: { stringValue: 'grpc' } },
                  { key: 'rpc.service', value: { stringValue: rpcService } },
                  { key: 'rpc.method', value: { stringValue: method } },
                  { key: 'rpc.grpc.status_code', value: { intValue: '0' } },
                  { key: 'server.address', value: { stringValue: ip } },
                  { key: 'server.port', value: { intValue: '8080' } },
                ],
                status: {},
              },
            ],
          },
        ],
      },
    ],
  }
}

function frontierNodes(g: NeatGraph): string[] {
  return g.filterNodes((_id, a) => (a as GraphNode).type === NodeType.FrontierNode)
}

describe('ClusterIP callee resolution through the k8s substrate (#1411)', () => {
  let tmpDir: string
  let ctx: IngestContext

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-clusterip-'))
    const graph: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    for (const name of WORKLOADS) ensureServiceNode(graph, name)
    ctx = { graph, errorsPath: path.join(tmpDir, 'errors.ndjson') }
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // What the connectors pipeline does with each deploy-state signal.
  function stampFromPoll(services: Service[] | undefined): void {
    const deployments = WORKLOADS.map(deployment)
    const pods = WORKLOADS.map(pod)
    for (const s of mapWorkloadsToSignals(deployments, pods, { namespace: 'astronomy-shop' }, undefined, services)) {
      if (!s.deployState) continue
      const name = parseK8sTargetName(s.targetName)!.serviceName
      mergeObservedDeployState(ctx.graph, `service:${name}`, s.deployState)
    }
  }

  it('maps each ClusterIP to the one workload its Service selects', () => {
    const map = addressesByDeployment(WORKLOADS.map(deployment), WORKLOADS.map(pod), SERVICES)
    expect(Object.fromEntries(map)).toEqual({
      checkout: ['10.96.124.37'],
      cart: ['10.96.246.31'],
      currency: ['10.96.24.162'],
      payment: ['10.96.19.87'],
      'product-catalog': ['10.96.247.8'],
    })
  })

  it('matches by the deployment selector when no pod is running', () => {
    const map = addressesByDeployment([deployment('cart')], [], [service('cart', '10.96.246.31')])
    expect(map.get('cart')).toEqual(['10.96.246.31'])
  })

  it('a span to a ClusterIP lands on the service, with no frontier node', async () => {
    stampFromPoll(SERVICES)
    expect((ctx.graph.getNodeAttributes('service:cart') as { observedAddresses?: string[] }).observedAddresses).toEqual([
      '10.96.246.31',
    ])
    const calls: Array<[string, string, string]> = [
      ['10.96.246.31', 'oteldemo.CartService', 'GetCart'],
      ['10.96.24.162', 'oteldemo.CurrencyService', 'Convert'],
      ['10.96.247.8', 'oteldemo.ProductCatalogService', 'GetProduct'],
      ['10.96.19.87', 'oteldemo.PaymentService', 'Charge'],
    ]
    for (const [ip, svc, method] of calls) {
      for (const span of parseOtlpRequest(grpcClientSpan(ip, svc, method))) await handleSpan(ctx, span)
    }
    expect(frontierNodes(ctx.graph)).toEqual([])
    for (const target of ['cart', 'currency', 'product-catalog', 'payment']) {
      expect(ctx.graph.hasEdge(`${EdgeType.CALLS}:OBSERVED:service:checkout->service:${target}`)).toBe(true)
    }
  })

  it('an IP no Service owns still mints a frontier', async () => {
    stampFromPoll(SERVICES)
    for (const span of parseOtlpRequest(grpcClientSpan('10.96.9.9', 'oteldemo.Unknown', 'Call'))) {
      await handleSpan(ctx, span)
    }
    expect(frontierNodes(ctx.graph)).toEqual(['frontier:10.96.9.9'])
  })

  it('without the Services read, the ClusterIP stays a frontier, as before', async () => {
    stampFromPoll(undefined)
    for (const span of parseOtlpRequest(grpcClientSpan('10.96.246.31', 'oteldemo.CartService', 'GetCart'))) {
      await handleSpan(ctx, span)
    }
    expect(frontierNodes(ctx.graph)).toEqual(['frontier:10.96.246.31'])
  })

  it('a frontier minted before the first poll promotes once the address is known', async () => {
    for (const span of parseOtlpRequest(grpcClientSpan('10.96.246.31', 'oteldemo.CartService', 'GetCart'))) {
      await handleSpan(ctx, span)
    }
    expect(frontierNodes(ctx.graph)).toEqual(['frontier:10.96.246.31'])
    stampFromPoll(SERVICES)
    expect(promoteFrontierNodes(ctx.graph)).toBe(1)
    expect(frontierNodes(ctx.graph)).toEqual([])
    expect(ctx.graph.hasEdge(`${EdgeType.CALLS}:OBSERVED:service:checkout->service:cart`)).toBe(true)
  })

  it('a later read without the Service clears the address', () => {
    stampFromPoll(SERVICES)
    stampFromPoll(SERVICES.filter((s) => s.metadata?.name !== 'cart'))
    expect((ctx.graph.getNodeAttributes('service:cart') as { observedAddresses?: string[] }).observedAddresses).toBeUndefined()
    expect((ctx.graph.getNodeAttributes('service:payment') as { observedAddresses?: string[] }).observedAddresses).toEqual([
      '10.96.19.87',
    ])
  })
})
