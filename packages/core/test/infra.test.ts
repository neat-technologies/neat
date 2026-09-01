import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge, InfraNode, ServiceNode } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'infra')

describe('infrastructure extraction', () => {
  beforeEach(() => resetGraph())

  it('docker-compose: emits InfraNodes for non-service entries + DEPENDS_ON edges', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'compose'))

    expect(graph.hasNode('service:fixture-web')).toBe(true)
    expect(graph.hasNode('infra:postgres:postgres')).toBe(true)
    expect(graph.hasNode('infra:redis:cache')).toBe(true)

    const postgres = graph.getNodeAttributes('infra:postgres:postgres') as InfraNode
    expect(postgres.kind).toBe('postgres')
    expect(postgres.provider).toBe('self')

    const dependsPg = 'DEPENDS_ON:service:fixture-web->infra:postgres:postgres'
    const dependsRedis = 'DEPENDS_ON:service:fixture-web->infra:redis:cache'
    expect(graph.hasEdge(dependsPg)).toBe(true)
    expect(graph.hasEdge(dependsRedis)).toBe(true)
  })

  it('Dockerfile: emits container-image InfraNode + RUNS_ON edge', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'dockerfile'))

    expect(graph.hasNode('infra:container-image:node:20')).toBe(true)
    const image = graph.getNodeAttributes('infra:container-image:node:20') as InfraNode
    expect(image.kind).toBe('container-image')

    // file-awareness §1 — RUNS_ON originates from the FileNode for Dockerfile
    const fileNodeId = 'file:fixture-api:Dockerfile'
    expect(graph.hasNode(fileNodeId)).toBe(true)
    const edgeId = `RUNS_ON:${fileNodeId}->infra:container-image:node:20`
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.type).toBe('RUNS_ON')
    // CMD line rides along as evidence so the entrypoint is queryable.
    expect(edge.evidence?.snippet).toContain('node')
  })

  it('Dockerfile: EXPOSE emits a port InfraNode + CONNECTS_TO edge', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'dockerfile'))

    const portNodeId = 'infra:port:8080'
    expect(graph.hasNode(portNodeId)).toBe(true)
    const port = graph.getNodeAttributes(portNodeId) as InfraNode
    expect(port.kind).toBe('port')

    const fileNodeId = 'file:fixture-api:Dockerfile'
    const portEdgeId = `CONNECTS_TO:${fileNodeId}->${portNodeId}`
    expect(graph.hasEdge(portEdgeId)).toBe(true)
    const portEdge = graph.getEdgeAttributes(portEdgeId) as GraphEdge
    expect(portEdge.type).toBe('CONNECTS_TO')
    expect(portEdge.provenance).toBe('EXTRACTED')
    expect(portEdge.evidence?.file).toBe('api/Dockerfile')
  })

  it('terraform: catalogues aws_* resources as InfraNodes', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'terraform'))

    const bucket = graph.getNodeAttributes('infra:aws_s3_bucket:uploads') as InfraNode
    expect(bucket.kind).toBe('aws_s3_bucket')
    expect(bucket.provider).toBe('aws')

    const table = graph.getNodeAttributes('infra:aws_dynamodb_table:orders') as InfraNode
    expect(table.kind).toBe('aws_dynamodb_table')
  })

  it('terraform: a referenced RDS is a connected node; an unreferenced bucket stays orphan', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'terraform-refs'))

    // The RDS instance and its security group are both referenced by the app
    // server, so DEPENDS_ON edges connect them into the topology.
    const rds = 'infra:aws_db_instance:main'
    const app = 'infra:aws_instance:app'
    expect(graph.hasNode(rds)).toBe(true)
    expect(graph.hasNode(app)).toBe(true)

    const dependsRds = `DEPENDS_ON:${app}->${rds}`
    expect(graph.hasEdge(dependsRds)).toBe(true)
    const edge = graph.getEdgeAttributes(dependsRds) as GraphEdge
    expect(edge.provenance).toBe('EXTRACTED')
    expect(edge.evidence?.snippet).toBe('aws_db_instance.main')
    expect(graph.hasEdge(`DEPENDS_ON:${app}->infra:aws_security_group:db`)).toBe(true)

    // The RDS is in use — something points at it.
    expect(graph.inDegree(rds)).toBeGreaterThan(0)

    // The unreferenced bucket has no edges at all — declared-but-unused stays
    // distinguishable from in-use.
    const orphan = 'infra:aws_s3_bucket:orphan'
    expect(graph.hasNode(orphan)).toBe(true)
    expect(graph.degree(orphan)).toBe(0)
  })

  it('k8s: catalogues Service + Deployment as InfraNodes, keyed name-only + namespace attr', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'k8s'))

    // Name-only id (not `default/web`): the only key the manifest and the live
    // cluster can both produce, matching NEAT's name-based identity. The namespace
    // rides as an attribute.
    const svc = graph.getNodeAttributes('infra:k8s-service:web') as InfraNode
    expect(svc.kind).toBe('k8s-service')
    expect(svc.provider).toBe('kubernetes')
    expect(svc.namespace).toBe('default')

    const deploy = graph.getNodeAttributes('infra:k8s-deployment:web') as InfraNode
    expect(deploy.kind).toBe('k8s-deployment')
    // Declared deploy state — the manifest's desired image + replica count.
    expect(deploy.image).toBe('nginx:1.25.3')
    expect(deploy.replicas).toBe(2)
    expect(deploy.namespace).toBe('default')
  })

  it('k8s: stamps declared image/replicas on the service node + a RUNS_ON edge', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'k8s'))

    // The manifest names a `web` Deployment; the fixture's package.json makes `web`
    // a discovered service, so the declared deploy state fuses onto `service:web` —
    // the same node the observed cluster reader stamps running image/ready onto.
    const service = graph.getNodeAttributes('service:web') as ServiceNode
    expect(service.declaredImage).toBe('nginx:1.25.3')
    expect(service.declaredReplicas).toBe(2)
    expect(service.platform).toBe('kubernetes')

    // Topology: the service RUNS_ON its declared k8s deployment, with evidence.
    const edgeId = 'RUNS_ON:service:web->infra:k8s-deployment:web'
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.provenance).toBe('EXTRACTED')
    expect(edge.evidence?.file).toBe('manifests.yaml')
  })
})
